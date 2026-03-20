import json
import logging
import os
import platform
import subprocess
import uuid
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests as http_requests
from flask import Flask, jsonify, render_template, request

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

IS_WINDOWS = platform.system() == "Windows"
HOSTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hosts.json")


# ===== Host Management Helpers =====

def _load_hosts():
    """Load remote hosts list from hosts.json."""
    try:
        with open(HOSTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_hosts(hosts):
    """Save remote hosts list to hosts.json."""
    with open(HOSTS_FILE, "w", encoding="utf-8") as f:
        json.dump(hosts, f, ensure_ascii=False, indent=2)


def _fetch_remote_gpu(host):
    """Fetch GPU data from a remote host. Returns None if offline."""
    try:
        url = host["url"].rstrip("/") + "/api/gpu"
        s = http_requests.Session()
        s.headers["Connection"] = "close"
        resp = s.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        s.close()
        if "error" in data:
            return None
        return {
            "host_id": host["id"],
            "host_name": host["name"],
            "data": data,
        }
    except Exception as e:
        logger.warning("Failed to fetch GPU data from %s (%s): %s", host["name"], host["url"], e)
        return None


# ===== Process Name Resolution =====

def _get_process_name(pid):
    """Resolve process name by PID. Uses /proc on Linux, tasklist on Windows."""
    if IS_WINDOWS:
        try:
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=5,
            )
            for line in result.stdout.strip().splitlines():
                parts = line.strip('"').split('","')
                if len(parts) >= 2:
                    return parts[0]
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
        return ""
    # Linux: read from /proc
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmdline = f.read().decode("utf-8", errors="replace").replace("\x00", " ").strip()
        if cmdline:
            return os.path.basename(cmdline.split()[0])
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        pass
    try:
        with open(f"/proc/{pid}/comm", "r") as f:
            return f.read().strip()
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        pass
    return ""


# ===== nvidia-smi Parsing =====

def parse_nvidia_smi():
    """Call nvidia-smi and parse XML output into structured data."""
    # On Windows, nvidia-smi is typically not on PATH
    if IS_WINDOWS:
        nvidia_smi = os.path.join(
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe",
        )
        if not os.path.isfile(nvidia_smi):
            nvidia_smi = "nvidia-smi"  # fallback to PATH
    else:
        nvidia_smi = "nvidia-smi"

    try:
        result = subprocess.run(
            [nvidia_smi, "-q", "-x"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return {"error": "nvidia-smi 執行失敗", "detail": result.stderr}
    except FileNotFoundError:
        return {"error": "找不到 nvidia-smi 指令，請確認已安裝 NVIDIA 驅動程式"}
    except subprocess.TimeoutExpired:
        return {"error": "nvidia-smi 執行逾時"}

    root = ET.fromstring(result.stdout)

    driver_version = root.findtext("driver_version", "N/A")
    cuda_version = root.findtext("cuda_version", "N/A")

    gpus = []
    for gpu in root.findall("gpu"):
        gpu_info = {
            "id": gpu.get("id", "N/A"),
            "name": gpu.findtext("product_name", "N/A"),
            "uuid": gpu.findtext("uuid", "N/A"),
            "driver_version": driver_version,
            "cuda_version": cuda_version,
            "fan_speed": gpu.findtext("fan_speed", "N/A"),
            "temperature": {
                "gpu": gpu.findtext("temperature/gpu_temp", "N/A"),
                "gpu_max": gpu.findtext("temperature/gpu_temp_max_threshold", "N/A"),
                "gpu_slowdown": gpu.findtext(
                    "temperature/gpu_temp_slow_threshold", "N/A"
                ),
            },
            "power": {
                "draw": gpu.findtext("gpu_power_readings/instant_power_draw", None)
                or gpu.findtext("gpu_power_readings/average_power_draw", "N/A"),
                "average": gpu.findtext("gpu_power_readings/average_power_draw", "N/A"),
                "limit": gpu.findtext("gpu_power_readings/current_power_limit", "N/A"),
                "default_limit": gpu.findtext("gpu_power_readings/default_power_limit", "N/A"),
                "max_limit": gpu.findtext(
                    "gpu_power_readings/max_power_limit", "N/A"
                ),
            },
            "memory": {
                "total": gpu.findtext("fb_memory_usage/total", "N/A"),
                "used": gpu.findtext("fb_memory_usage/used", "N/A"),
                "free": gpu.findtext("fb_memory_usage/free", "N/A"),
            },
            "utilization": {
                "gpu": gpu.findtext("utilization/gpu_util", "N/A"),
                "memory": gpu.findtext("utilization/memory_util", "N/A"),
                "encoder": gpu.findtext("utilization/encoder_util", "N/A"),
                "decoder": gpu.findtext("utilization/decoder_util", "N/A"),
            },
            "pci": {
                "bus_id": gpu.findtext("pci/pci_bus_id", "N/A"),
                "link_gen_current": gpu.findtext(
                    "pci/pci_gpu_link_info/pcie_gen/current_link_gen", "N/A"
                ),
                "link_width_current": gpu.findtext(
                    "pci/pci_gpu_link_info/link_widths/current_link_width", "N/A"
                ),
            },
            "clocks": {
                "graphics": gpu.findtext("clocks/graphics_clock", "N/A"),
                "sm": gpu.findtext("clocks/sm_clock", "N/A"),
                "memory": gpu.findtext("clocks/mem_clock", "N/A"),
            },
            "processes": [],
        }

        # Parse processes
        processes = gpu.find("processes")
        if processes is not None:
            for proc in processes.findall("process_info"):
                pid = proc.findtext("pid", "N/A")
                name = proc.findtext("process_name", "") or ""
                # In containers, nvidia-smi cannot see host process names.
                # Fall back to reading /proc/<pid>/cmdline (requires pid=host).
                if not name.strip() and pid != "N/A":
                    name = _get_process_name(pid)
                gpu_info["processes"].append(
                    {
                        "pid": pid,
                        "name": name or "N/A",
                        "used_memory": proc.findtext("used_memory", "N/A"),
                        "type": proc.findtext("type", "N/A"),
                    }
                )

        gpus.append(gpu_info)

    return {"gpus": gpus, "driver_version": driver_version, "cuda_version": cuda_version}


# ===== Routes =====

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/gpu")
def gpu_data():
    data = parse_nvidia_smi()
    return jsonify(data)


@app.route("/api/hosts", methods=["GET"])
def list_hosts():
    return jsonify(_load_hosts())


@app.route("/api/hosts", methods=["POST"])
def add_host():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    url = (body.get("url") or "").strip()
    if not name or not url:
        return jsonify({"error": "name 和 url 為必填欄位"}), 400

    hosts = _load_hosts()
    new_host = {"id": uuid.uuid4().hex[:8], "name": name, "url": url}
    hosts.append(new_host)
    _save_hosts(hosts)
    return jsonify(new_host), 201


@app.route("/api/hosts/<host_id>", methods=["DELETE"])
def delete_host(host_id):
    hosts = _load_hosts()
    new_hosts = [h for h in hosts if h["id"] != host_id]
    if len(new_hosts) == len(hosts):
        return jsonify({"error": "找不到該主機"}), 404
    _save_hosts(new_hosts)
    return "", 204


@app.route("/api/all-gpus")
def all_gpus():
    results = []

    # Local GPU data
    local_data = parse_nvidia_smi()
    if "error" not in local_data:
        results.append({
            "host_id": "local",
            "host_name": "本機",
            "data": local_data,
        })

    # Remote hosts — fetch in parallel
    hosts = _load_hosts()
    if hosts:
        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = {pool.submit(_fetch_remote_gpu, h): h for h in hosts}
            for future in as_completed(futures):
                result = future.result()
                if result is not None:
                    results.append(result)

    return jsonify({"hosts": results})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
