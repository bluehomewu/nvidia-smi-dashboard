import os
import subprocess
import xml.etree.ElementTree as ET

from flask import Flask, jsonify, render_template

app = Flask(__name__)


def _get_process_name(pid):
    """Read process name from /proc (works with --pid=host in Docker)."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmdline = f.read().decode("utf-8", errors="replace").replace("\x00", " ").strip()
        if cmdline:
            # Return the basename of the first argument
            return os.path.basename(cmdline.split()[0])
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        pass
    try:
        with open(f"/proc/{pid}/comm", "r") as f:
            return f.read().strip()
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        pass
    return ""


def parse_nvidia_smi():
    """Call nvidia-smi and parse XML output into structured data."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "-q", "-x"],
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


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/gpu")
def gpu_data():
    data = parse_nvidia_smi()
    return jsonify(data)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
