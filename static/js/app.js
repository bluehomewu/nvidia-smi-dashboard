const REFRESH_INTERVAL = 3000;
const HISTORY_LENGTH = 60; // Keep 60 data points (~3 minutes at 3s interval)
const COOKIE_NAME = "gpu_expanded";
const COOKIE_DAYS = 30;

// Per-GPU history data (keyed by "hostId-gpuIndex")
const gpuHistory = {};

// Per-GPU chart instances (keyed by "hostId-gpuIndex")
const gpuCharts = {};

// Total GPU count across all hosts
let totalGpuCount = 0;

// Previous host structure signature for detecting changes
let lastStructure = "";

// ===== Theme Management =====
function getThemeSetting() {
  const m = document.cookie.match(/(?:^|; )theme=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "auto";
}

function setTheme(mode) {
  const d = new Date();
  d.setTime(d.getTime() + COOKIE_DAYS * 86400000);
  document.cookie = "theme=" + mode + ";expires=" + d.toUTCString() + ";path=/;SameSite=Lax";

  if (mode === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", mode);
  }

  updateThemeButtons();
  rebuildAllCharts();
}

function updateThemeButtons() {
  const current = getThemeSetting();
  document.querySelectorAll("[data-theme-btn]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-theme-btn") === current);
  });
}

function getCSS(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function rebuildAllCharts() {
  Object.keys(gpuCharts).forEach((key) => {
    Object.values(gpuCharts[key]).forEach((c) => c.destroy());
    delete gpuCharts[key];
  });
  if (lastData) {
    setTimeout(() => {
      lastData.hosts.forEach((hostEntry) => {
        hostEntry.data.gpus.forEach((gpu, i) => {
          const key = hostEntry.host_id + "-" + i;
          createOrUpdateCharts(key, gpu);
        });
      });
    }, 50);
  }
}

// Listen for system theme changes when in auto mode
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (getThemeSetting() === "auto") {
    rebuildAllCharts();
  }
});

// Initialize theme buttons on load
document.addEventListener("DOMContentLoaded", updateThemeButtons);

// ===== Cookie Helpers =====
function getCookie(name) {
  const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + days * 86400000);
  document.cookie = name + "=" + encodeURIComponent(value) + ";expires=" + d.toUTCString() + ";path=/;SameSite=Lax";
}

function getExpandedSet() {
  const raw = getCookie(COOKIE_NAME);
  if (raw === null) return null;
  if (raw === "") return new Set();
  return new Set(raw.split(","));
}

function saveExpandedSet(expandedSet) {
  setCookie(COOKIE_NAME, [...expandedSet].join(","), COOKIE_DAYS);
}

function isExpanded(key) {
  const stored = getExpandedSet();
  if (stored === null) {
    return totalGpuCount <= 1;
  }
  return stored.has(key);
}

function toggleGpu(key) {
  let expanded = getExpandedSet();
  if (expanded === null) {
    expanded = new Set();
    if (totalGpuCount <= 1) {
      if (lastData) {
        lastData.hosts.forEach((h) => {
          h.data.gpus.forEach((_, i) => expanded.add(h.host_id + "-" + i));
        });
      }
    }
  }
  if (expanded.has(key)) {
    expanded.delete(key);
  } else {
    expanded.add(key);
  }
  saveExpandedSet(expanded);

  const card = document.querySelector('.gpu-card[data-gpu-key="' + key + '"]');
  if (!card) return;

  card.classList.toggle("collapsed");

  if (!card.classList.contains("collapsed")) {
    if (gpuCharts[key]) {
      Object.values(gpuCharts[key]).forEach((c) => c.destroy());
      delete gpuCharts[key];
    }
    setTimeout(() => {
      if (lastData) {
        lastData.hosts.forEach((h) => {
          h.data.gpus.forEach((gpu, i) => {
            if (h.host_id + "-" + i === key) {
              createOrUpdateCharts(key, gpu);
            }
          });
        });
      }
    }, 50);
  }
}

// ===== Utilities =====
function parseNumeric(str) {
  if (!str || str === "N/A") return null;
  const match = str.match(/([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

function getUnit(str) {
  if (!str || str === "N/A") return "";
  const match = str.match(/[\d.]+\s*(.*)/);
  return match ? match[1].trim() : "";
}

function getProgressColor(pct) {
  if (pct < 50) return "green";
  if (pct < 80) return "orange";
  return "red";
}

function formatValue(raw) {
  return raw && raw !== "N/A" ? raw : "--";
}

// ===== History =====
function initHistory(key) {
  if (!gpuHistory[key]) {
    gpuHistory[key] = {
      labels: [],
      gpuUtil: [],
      memUsed: [],
      temp: [],
      power: [],
    };
  }
}

function pushHistory(key, gpuUtil, memUsed, temp, power) {
  initHistory(key);
  const h = gpuHistory[key];
  const now = new Date().toLocaleTimeString(getI18nLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  h.labels.push(now);
  h.gpuUtil.push(gpuUtil);
  h.memUsed.push(memUsed);
  h.temp.push(temp);
  h.power.push(power);

  if (h.labels.length > HISTORY_LENGTH) {
    h.labels.shift();
    h.gpuUtil.shift();
    h.memUsed.shift();
    h.temp.shift();
    h.power.shift();
  }
}

// ===== Charts =====
function createChartConfig(label, data, labels, color, yMax, unit) {
  const gridColor = getCSS("--chart-grid");
  const tickColor = getCSS("--chart-tick");
  const tooltipBg = getCSS("--chart-tooltip-bg");
  const textPrimary = getCSS("--text-primary");
  const borderColor = getCSS("--border-color");

  return {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: label,
          data: data,
          borderColor: color,
          backgroundColor: color + "20",
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHitRadius: 8,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: tooltipBg,
          titleColor: textPrimary,
          bodyColor: textPrimary,
          borderColor: borderColor,
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: function (ctx) {
              return ctx.parsed.y !== null ? ctx.parsed.y.toFixed(1) + " " + unit : "--";
            },
          },
        },
      },
      scales: {
        x: {
          display: true,
          grid: { color: gridColor },
          ticks: { color: tickColor, maxTicksLimit: 8, font: { size: 10 } },
        },
        y: {
          min: 0,
          max: yMax,
          grid: { color: gridColor },
          ticks: {
            color: tickColor,
            font: { size: 10 },
            callback: function (val) { return val + " " + unit; },
          },
        },
      },
    },
  };
}

function createOrUpdateCharts(key, gpu) {
  const card = document.querySelector('.gpu-card[data-gpu-key="' + key + '"]');
  if (card && card.classList.contains("collapsed")) return;

  const h = gpuHistory[key];
  if (!h) return;

  const memTotal = parseNumeric(gpu.memory.total) || 100;
  const powerLimit = parseNumeric(gpu.power.limit) || parseNumeric(gpu.power.max_limit) || 400;

  const chartDefs = [
    { id: "chart-util-" + key, label: S("gpu_utilization"), data: h.gpuUtil, color: "#76b900", max: 100, unit: "%" },
    { id: "chart-mem-" + key, label: S("memory_usage"), data: h.memUsed, color: "#4fc3f7", max: memTotal, unit: "MiB" },
    { id: "chart-temp-" + key, label: S("temperature"), data: h.temp, color: "#ffb74d", max: 100, unit: "\u00B0C" },
    { id: "chart-power-" + key, label: S("power_draw"), data: h.power, color: "#ef5350", max: Math.ceil(powerLimit / 50) * 50, unit: "W" },
  ];

  if (!gpuCharts[key]) gpuCharts[key] = {};

  chartDefs.forEach((def) => {
    const canvas = document.getElementById(def.id);
    if (!canvas) return;

    if (gpuCharts[key][def.id]) {
      const chart = gpuCharts[key][def.id];
      chart.data.labels = h.labels;
      chart.data.datasets[0].data = def.data;
      chart.options.scales.y.max = def.max;
      chart.update("none");
    } else {
      const ctx = canvas.getContext("2d");
      gpuCharts[key][def.id] = new Chart(
        ctx,
        createChartConfig(def.label, def.data, h.labels, def.color, def.max, def.unit)
      );
    }
  });
}

// ===== Render =====
function renderGPU(gpu, key, gpuCount) {
  const localIndex = key.split("-").pop();
  const gpuUtil = parseNumeric(gpu.utilization.gpu);
  const memUsed = parseNumeric(gpu.memory.used);
  const memTotal = parseNumeric(gpu.memory.total);
  const memPct = memUsed !== null && memTotal ? (memUsed / memTotal) * 100 : 0;
  const temp = parseNumeric(gpu.temperature.gpu);
  const tempMax = parseNumeric(gpu.temperature.gpu_max);
  const tempPct = temp !== null && tempMax ? (temp / tempMax) * 100 : 0;
  const powerDraw = parseNumeric(gpu.power.draw);
  const powerLimit = parseNumeric(gpu.power.limit);
  const powerPct = powerDraw !== null && powerLimit ? (powerDraw / powerLimit) * 100 : 0;

  pushHistory(key, gpuUtil, memUsed, temp, powerDraw);

  const collapsed = !isExpanded(key);
  const collapsedClass = collapsed ? " collapsed" : "";

  const fanDisplay =
    gpu.fan_speed && gpu.fan_speed !== "N/A"
      ? `<div style="text-align:right">
          <div style="font-size:13px;color:var(--text-secondary)">${S("fan_speed")}</div>
          <div style="font-size:20px;font-weight:700">${gpu.fan_speed}</div>
        </div>`
      : "";

  const processRows =
    gpu.processes.length > 0
      ? gpu.processes
          .map(
            (p) => `
        <tr>
          <td class="pid">${p.pid}</td>
          <td>${p.type || "--"}</td>
          <td title="${p.name}">${p.name.length > 50 ? "..." + p.name.slice(-47) : p.name}</td>
          <td class="mem">${formatValue(p.used_memory)}</td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="4" class="no-process">${S("no_running_processes")}</td></tr>`;

  return `
    <div class="gpu-card${collapsedClass}" data-gpu-key="${key}">
      <div class="gpu-card-header" onclick="toggleGpu('${key}')">
        <div class="gpu-header-left">
          <div class="gpu-toggle">&#9660;</div>
          <div>
            <div class="gpu-name">GPU ${localIndex}: ${gpu.name}</div>
            <div class="gpu-id">PCI Bus: ${gpu.pci.bus_id} | UUID: ${gpu.uuid.substring(0, 20)}...</div>
          </div>
        </div>
        <div class="gpu-header-right">
          <div class="gpu-summary">
            <div class="gpu-summary-item">
              <span class="summary-label">${S("utilization_short")}</span>
              <span class="summary-val" style="color:var(--accent-green)" data-summary="util">${gpuUtil !== null ? gpuUtil + "%" : "--"}</span>
            </div>
            <div class="gpu-summary-item">
              <span class="summary-label">${S("memory_short")}</span>
              <span class="summary-val" style="color:var(--accent-blue)" data-summary="mem">${memPct.toFixed(1)}%</span>
            </div>
            <div class="gpu-summary-item">
              <span class="summary-label">${S("temperature_short")}</span>
              <span class="summary-val" style="color:var(--accent-orange)" data-summary="temp">${temp !== null ? temp + "\u00B0C" : "--"}</span>
            </div>
            <div class="gpu-summary-item">
              <span class="summary-label">${S("power_short")}</span>
              <span class="summary-val" style="color:var(--accent-red)" data-summary="power">${powerDraw !== null ? powerDraw.toFixed(1) + " W" : "--"}</span>
            </div>
          </div>
          ${fanDisplay}
        </div>
      </div>
      <div class="gpu-card-body">
        <!-- Key Metrics -->
        <div class="metrics-grid">
          <div class="metric-card green">
            <div class="metric-label">${S("gpu_utilization")}</div>
            <div class="metric-value">${gpuUtil !== null ? gpuUtil + "%" : "--"}</div>
            <div class="metric-sub">${S("gpu_load_sub")}</div>
          </div>
          <div class="metric-card blue">
            <div class="metric-label">${S("memory_usage")}</div>
            <div class="metric-value">${memUsed !== null ? memUsed + " " + getUnit(gpu.memory.used) : "--"}</div>
            <div class="metric-sub">${S("memory_total_pct", formatValue(gpu.memory.total), memPct.toFixed(1) + "%")}</div>
          </div>
          <div class="metric-card orange">
            <div class="metric-label">${S("temperature")}</div>
            <div class="metric-value">${temp !== null ? temp + "\u00B0C" : "--"}</div>
            <div class="metric-sub">${S("slowdown_threshold", formatValue(gpu.temperature.gpu_slowdown))}</div>
          </div>
          <div class="metric-card red">
            <div class="metric-label">${S("power_draw")}</div>
            <div class="metric-value">${powerDraw !== null ? powerDraw.toFixed(1) + " W" : "--"}</div>
            <div class="metric-sub">${S("power_limit", formatValue(gpu.power.limit))}</div>
          </div>
        </div>

        <!-- Progress Bars -->
        <div class="progress-section">
          <div class="progress-header">
            <span class="progress-title">${S("gpu_utilization")}</span>
            <span class="progress-value" style="color:var(--accent-green)">${gpuUtil !== null ? gpuUtil + "%" : "--"}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${getProgressColor(gpuUtil || 0)}" style="width:${gpuUtil || 0}%"></div>
          </div>
        </div>
        <div class="progress-section">
          <div class="progress-header">
            <span class="progress-title">${S("memory_utilization")}</span>
            <span class="progress-value" style="color:var(--accent-blue)">${memPct.toFixed(1)}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${getProgressColor(memPct)}" style="width:${memPct}%"></div>
          </div>
        </div>
        <div class="progress-section">
          <div class="progress-header">
            <span class="progress-title">${S("temperature")}</span>
            <span class="progress-value" style="color:var(--accent-orange)">${temp !== null ? temp + "\u00B0C" : "--"}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${getProgressColor(tempPct)}" style="width:${tempPct}%"></div>
          </div>
        </div>
        <div class="progress-section">
          <div class="progress-header">
            <span class="progress-title">${S("power_draw")}</span>
            <span class="progress-value" style="color:var(--accent-red)">${powerDraw !== null ? powerDraw.toFixed(1) + " W" : "--"}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${getProgressColor(powerPct)}" style="width:${powerPct}%"></div>
          </div>
        </div>

        <!-- Charts -->
        <div class="charts-section">
          <div class="charts-title">${S("history_charts")}</div>
          <div class="charts-grid">
            <div class="chart-container">
              <div class="chart-label" style="color:var(--accent-green)">${S("chart_gpu_util")}</div>
              <div class="chart-wrapper"><canvas id="chart-util-${key}"></canvas></div>
            </div>
            <div class="chart-container">
              <div class="chart-label" style="color:var(--accent-blue)">${S("chart_mem_usage")}</div>
              <div class="chart-wrapper"><canvas id="chart-mem-${key}"></canvas></div>
            </div>
            <div class="chart-container">
              <div class="chart-label" style="color:var(--accent-orange)">${S("chart_temperature")}</div>
              <div class="chart-wrapper"><canvas id="chart-temp-${key}"></canvas></div>
            </div>
            <div class="chart-container">
              <div class="chart-label" style="color:var(--accent-red)">${S("chart_power")}</div>
              <div class="chart-wrapper"><canvas id="chart-power-${key}"></canvas></div>
            </div>
          </div>
        </div>

        <!-- Detail Sections -->
        <div class="details-grid">
          <div class="detail-section">
            <div class="detail-section-title">&#9201; ${S("clock_frequencies")}</div>
            <div class="detail-row"><span class="detail-key">${S("graphics_clock")}</span><span class="detail-val">${formatValue(gpu.clocks.graphics)}</span></div>
            <div class="detail-row"><span class="detail-key">${S("sm_clock")}</span><span class="detail-val">${formatValue(gpu.clocks.sm)}</span></div>
            <div class="detail-row"><span class="detail-key">${S("memory_clock")}</span><span class="detail-val">${formatValue(gpu.clocks.memory)}</span></div>
          </div>
          <div class="detail-section">
            <div class="detail-section-title">&#9889; ${S("utilization_details")}</div>
            <div class="detail-row"><span class="detail-key">${S("gpu_utilization")}</span><span class="detail-val">${formatValue(gpu.utilization.gpu)}</span></div>
            <div class="detail-row"><span class="detail-key">${S("memory_utilization")}</span><span class="detail-val">${formatValue(gpu.utilization.memory)}</span></div>
            <div class="detail-row"><span class="detail-key">${S("encoder")}</span><span class="detail-val">${formatValue(gpu.utilization.encoder)}</span></div>
            <div class="detail-row"><span class="detail-key">${S("decoder")}</span><span class="detail-val">${formatValue(gpu.utilization.decoder)}</span></div>
          </div>
          <div class="detail-section">
            <div class="detail-section-title">&#128268; ${S("pci_info")}</div>
            <div class="detail-row"><span class="detail-key">Bus ID</span><span class="detail-val">${formatValue(gpu.pci.bus_id)}</span></div>
            <div class="detail-row"><span class="detail-key">${S("pcie_generation")}</span><span class="detail-val">Gen ${formatValue(gpu.pci.link_gen_current)}</span></div>
            <div class="detail-row"><span class="detail-key">${S("link_width")}</span><span class="detail-val">${formatValue(gpu.pci.link_width_current)}</span></div>
          </div>
        </div>

        <!-- Processes -->
        <div class="process-section">
          <div class="process-section-title">&#128187; ${S("running_processes", gpu.processes.length)}</div>
          <div class="process-table-wrap">
          <table class="process-table">
            <thead>
              <tr>
                <th>PID</th>
                <th>${S("process_type")}</th>
                <th>${S("process_name")}</th>
                <th>${S("process_memory")}</th>
              </tr>
            </thead>
            <tbody>
              ${processRows}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderError(msg) {
  document.getElementById("gpu-container").innerHTML = `
    <div class="error-card">
      <h3>${S("error_title")}</h3>
      <p>${msg}</p>
    </div>
  `;
}

function renderLoading() {
  document.getElementById("gpu-container").innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <div>${S("loading_gpu_info")}</div>
    </div>
  `;
}

// ===== Data Fetch & Update =====
let initialized = false;
let lastData = null;

function getStructureSignature(data) {
  return data.hosts.map((h) => h.host_id + ":" + h.data.gpus.length).sort().join("|");
}

function getHostDisplayName(hostEntry) {
  if (hostEntry.host_id === "local") return S("local_host");
  return hostEntry.host_name;
}

async function fetchData() {
  try {
    const resp = await fetch("/api/all-gpus");
    const data = await resp.json();

    lastData = data;

    // Count total GPUs
    totalGpuCount = 0;
    data.hosts.forEach((h) => { totalGpuCount += h.data.gpus.length; });

    // Update header with local host info
    const localHost = data.hosts.find((h) => h.host_id === "local");
    if (localHost) {
      document.getElementById("driver-version").textContent = localHost.data.driver_version || "--";
      document.getElementById("cuda-version").textContent = localHost.data.cuda_version || "--";
    }
    document.getElementById("gpu-count").textContent = totalGpuCount + " " + S("gpu_count_suffix");

    const now = new Date();
    document.getElementById("last-update").textContent = S("last_update", now.toLocaleTimeString(getI18nLocale()));

    const container = document.getElementById("gpu-container");
    const newStructure = getStructureSignature(data);

    if (!initialized || lastStructure !== newStructure) {
      // Full re-render
      Object.values(gpuCharts).forEach((charts) => {
        Object.values(charts).forEach((c) => c.destroy());
      });
      Object.keys(gpuCharts).forEach((k) => delete gpuCharts[k]);

      let html = "";
      data.hosts.forEach((hostEntry) => {
        const hostName = getHostDisplayName(hostEntry);
        const driverInfo = hostEntry.data.driver_version && hostEntry.data.driver_version !== "N/A"
          ? S("driver_cuda_info", hostEntry.data.driver_version, hostEntry.data.cuda_version || "--")
          : "";
        html += '<div class="host-group">';
        html += '<div class="host-group-header">';
        html += '<span>&#128421; ' + hostName + '</span>';
        if (driverInfo) {
          html += '<span class="host-driver-info">' + driverInfo + '</span>';
        }
        html += '</div>';
        hostEntry.data.gpus.forEach((gpu, i) => {
          const key = hostEntry.host_id + "-" + i;
          html += renderGPU(gpu, key, hostEntry.data.gpus.length);
        });
        html += '</div>';
      });

      if (html === "") {
        html = '<div class="error-card"><h3>' + S("no_gpu_available") + '</h3><p>' + S("no_gpu_detail") + '</p></div>';
      }

      container.innerHTML = html;

      data.hosts.forEach((hostEntry) => {
        hostEntry.data.gpus.forEach((gpu, i) => {
          const key = hostEntry.host_id + "-" + i;
          createOrUpdateCharts(key, gpu);
        });
      });

      lastStructure = newStructure;
      initialized = true;
    } else {
      // Incremental update
      data.hosts.forEach((hostEntry) => {
        hostEntry.data.gpus.forEach((gpu, i) => {
          const key = hostEntry.host_id + "-" + i;
          updateGPUMetrics(gpu, key);
          createOrUpdateCharts(key, gpu);
        });
      });
    }
  } catch (err) {
    renderError(S("server_connection_error", err.message));
  }
}

function updateGPUMetrics(gpu, key) {
  const gpuUtil = parseNumeric(gpu.utilization.gpu);
  const memUsed = parseNumeric(gpu.memory.used);
  const memTotal = parseNumeric(gpu.memory.total);
  const memPct = memUsed !== null && memTotal ? (memUsed / memTotal) * 100 : 0;
  const temp = parseNumeric(gpu.temperature.gpu);
  const tempMax = parseNumeric(gpu.temperature.gpu_max);
  const tempPct = temp !== null && tempMax ? (temp / tempMax) * 100 : 0;
  const powerDraw = parseNumeric(gpu.power.draw);
  const powerLimit = parseNumeric(gpu.power.limit);
  const powerPct = powerDraw !== null && powerLimit ? (powerDraw / powerLimit) * 100 : 0;

  pushHistory(key, gpuUtil, memUsed, temp, powerDraw);

  const card = document.querySelector('.gpu-card[data-gpu-key="' + key + '"]');
  if (!card) return;

  // Update summary
  const summaryUtil = card.querySelector('[data-summary="util"]');
  const summaryMem = card.querySelector('[data-summary="mem"]');
  const summaryTemp = card.querySelector('[data-summary="temp"]');
  const summaryPower = card.querySelector('[data-summary="power"]');
  if (summaryUtil) summaryUtil.textContent = gpuUtil !== null ? gpuUtil + "%" : "--";
  if (summaryMem) summaryMem.textContent = memPct.toFixed(1) + "%";
  if (summaryTemp) summaryTemp.textContent = temp !== null ? temp + "\u00B0C" : "--";
  if (summaryPower) summaryPower.textContent = powerDraw !== null ? powerDraw.toFixed(1) + " W" : "--";

  // Update metric cards
  const metricValues = card.querySelectorAll(".metric-value");
  if (metricValues[0]) metricValues[0].textContent = gpuUtil !== null ? gpuUtil + "%" : "--";
  if (metricValues[1]) metricValues[1].textContent = memUsed !== null ? memUsed + " " + getUnit(gpu.memory.used) : "--";
  if (metricValues[2]) metricValues[2].textContent = temp !== null ? temp + "\u00B0C" : "--";
  if (metricValues[3]) metricValues[3].textContent = powerDraw !== null ? powerDraw.toFixed(1) + " W" : "--";

  const metricSubs = card.querySelectorAll(".metric-sub");
  if (metricSubs[1]) metricSubs[1].textContent = S("memory_total_pct", formatValue(gpu.memory.total), memPct.toFixed(1) + "%");
  if (metricSubs[3]) metricSubs[3].textContent = S("power_limit", formatValue(gpu.power.limit));

  // Update progress bars
  const fills = card.querySelectorAll(".progress-fill");
  const pValues = card.querySelectorAll(".progress-value");

  if (fills[0]) { fills[0].style.width = (gpuUtil || 0) + "%"; fills[0].className = "progress-fill " + getProgressColor(gpuUtil || 0); }
  if (pValues[0]) pValues[0].textContent = gpuUtil !== null ? gpuUtil + "%" : "--";
  if (fills[1]) { fills[1].style.width = memPct + "%"; fills[1].className = "progress-fill " + getProgressColor(memPct); }
  if (pValues[1]) pValues[1].textContent = memPct.toFixed(1) + "%";
  if (fills[2]) { fills[2].style.width = tempPct + "%"; fills[2].className = "progress-fill " + getProgressColor(tempPct); }
  if (pValues[2]) pValues[2].textContent = temp !== null ? temp + "\u00B0C" : "--";
  if (fills[3]) { fills[3].style.width = powerPct + "%"; fills[3].className = "progress-fill " + getProgressColor(powerPct); }
  if (pValues[3]) pValues[3].textContent = powerDraw !== null ? powerDraw.toFixed(1) + " W" : "--";

  // Update process table
  const tbody = card.querySelector(".process-table tbody");
  if (tbody) {
    tbody.innerHTML =
      gpu.processes.length > 0
        ? gpu.processes
            .map(
              (p) => `
          <tr>
            <td class="pid">${p.pid}</td>
            <td>${p.type || "--"}</td>
            <td title="${p.name}">${p.name.length > 50 ? "..." + p.name.slice(-47) : p.name}</td>
            <td class="mem">${formatValue(p.used_memory)}</td>
          </tr>`
            )
            .join("")
        : `<tr><td colspan="4" class="no-process">${S("no_running_processes")}</td></tr>`;
  }

  const procTitle = card.querySelector(".process-section-title");
  if (procTitle) procTitle.innerHTML = `&#128187; ${S("running_processes", gpu.processes.length)}`;
}

// ===== Settings Modal =====
function openSettingsModal() {
  document.getElementById("settings-modal").classList.add("active");
  updateThemeButtons();
  updateLangSwitcher();
  showSettingsPage("main");
}

function closeSettingsModal() {
  document.getElementById("settings-modal").classList.remove("active");
}

function showSettingsPage(page) {
  const mainPage = document.getElementById("settings-page-main");
  const hostsPage = document.getElementById("settings-page-hosts");
  if (page === "hosts") {
    mainPage.classList.add("slide-out");
    hostsPage.classList.add("active");
    loadHosts();
  } else {
    mainPage.classList.remove("slide-out");
    hostsPage.classList.remove("active");
  }
}

document.addEventListener("click", function (e) {
  if (e.target.id === "settings-modal") {
    closeSettingsModal();
  }
});

async function loadHosts() {
  try {
    const resp = await fetch("/api/hosts");
    const hosts = await resp.json();
    const listEl = document.getElementById("host-list");
    if (hosts.length === 0) {
      listEl.innerHTML = '<div class="no-hosts">' + S("no_remote_hosts") + '</div>';
      return;
    }
    listEl.innerHTML = hosts
      .map(
        (h) => `
      <div class="host-item">
        <div class="host-item-info">
          <span class="host-item-name">${h.name}</span>
          <span class="host-item-url">${h.url}</span>
        </div>
        <button class="host-delete-btn" onclick="deleteHost('${h.id}')">${S("delete_btn")}</button>
      </div>`
      )
      .join("");
  } catch (err) {
    document.getElementById("host-list").innerHTML =
      '<div class="no-hosts">' + S("load_hosts_failed") + '</div>';
  }
}

async function addHost() {
  const nameInput = document.getElementById("host-name-input");
  const urlInput = document.getElementById("host-url-input");
  const name = nameInput.value.trim();
  const url = urlInput.value.trim();
  if (!name || !url) return;

  try {
    await fetch("/api/hosts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, url: url }),
    });
    nameInput.value = "";
    urlInput.value = "";
    loadHosts();
  } catch (err) {
    // silently fail
  }
}

async function deleteHost(id) {
  try {
    await fetch("/api/hosts/" + id, { method: "DELETE" });
    loadHosts();
  } catch (err) {
    // silently fail
  }
}

// ===== Language Switcher =====
function updateLangSwitcher() {
  const current = getLangSetting();
  document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-lang-btn") === current);
  });
}

async function onLangChange(value) {
  await switchLanguage(value);
  updateLangSwitcher();
  updateThemeButtons();
  // Force full re-render of GPU cards
  initialized = false;
  lastStructure = "";
  if (lastData) {
    fetchData();
  }
}

// ===== Initialization =====
(async function () {
  await initI18n();
  updateLangSwitcher();
  renderLoading();
  fetchData();
  setInterval(fetchData, REFRESH_INTERVAL);
})();
