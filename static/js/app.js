const REFRESH_INTERVAL = 3000;
const HISTORY_LENGTH = 60; // Keep 60 data points (~3 minutes at 3s interval)
const COOKIE_NAME = "gpu_expanded";
const COOKIE_DAYS = 30;

// Per-GPU history data
const gpuHistory = {};

// Per-GPU chart instances
const gpuCharts = {};

// Total GPU count (set after first fetch)
let totalGpuCount = 0;

// ===== Theme Management =====
function getThemeSetting() {
  const m = document.cookie.match(/(?:^|; )theme=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "auto";
}

function setTheme(mode) {
  // mode: "light", "dark", "auto"
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
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-theme-btn") === current);
  });
}

function getCSS(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function rebuildAllCharts() {
  // Destroy and recreate all charts so they pick up new theme colors
  Object.keys(gpuCharts).forEach((gpuIndex) => {
    Object.values(gpuCharts[gpuIndex]).forEach((c) => c.destroy());
    delete gpuCharts[gpuIndex];
  });
  if (lastData) {
    // Small delay to let CSS variables update
    setTimeout(() => {
      lastData.gpus.forEach((gpu, i) => createOrUpdateCharts(i, gpu));
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
  if (raw === null) return null; // No cookie yet
  if (raw === "") return new Set();
  return new Set(raw.split(",").map(Number));
}

function saveExpandedSet(expandedSet) {
  setCookie(COOKIE_NAME, [...expandedSet].join(","), COOKIE_DAYS);
}

function isExpanded(index) {
  const stored = getExpandedSet();
  if (stored === null) {
    // No cookie: single GPU = expanded, multi-GPU = collapsed
    return totalGpuCount <= 1;
  }
  return stored.has(index);
}

function toggleGpu(index) {
  let expanded = getExpandedSet();
  if (expanded === null) {
    // Initialize from current default
    expanded = new Set();
    if (totalGpuCount <= 1) {
      for (let i = 0; i < totalGpuCount; i++) expanded.add(i);
    }
  }
  if (expanded.has(index)) {
    expanded.delete(index);
  } else {
    expanded.add(index);
  }
  saveExpandedSet(expanded);

  const card = document.querySelectorAll(".gpu-card")[index];
  if (!card) return;

  card.classList.toggle("collapsed");

  // When expanding, (re-)create charts since canvas may have been hidden
  if (!card.classList.contains("collapsed")) {
    if (gpuCharts[index]) {
      Object.values(gpuCharts[index]).forEach((c) => c.destroy());
      delete gpuCharts[index];
    }
    // Small delay to let CSS transition expose the canvas
    setTimeout(() => {
      if (lastData && lastData.gpus[index]) {
        createOrUpdateCharts(index, lastData.gpus[index]);
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
function initHistory(gpuIndex) {
  if (!gpuHistory[gpuIndex]) {
    gpuHistory[gpuIndex] = {
      labels: [],
      gpuUtil: [],
      memUsed: [],
      temp: [],
      power: [],
    };
  }
}

function pushHistory(gpuIndex, gpuUtil, memUsed, temp, power) {
  initHistory(gpuIndex);
  const h = gpuHistory[gpuIndex];
  const now = new Date().toLocaleTimeString("zh-TW", {
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

function createOrUpdateCharts(gpuIndex, gpu) {
  // Don't create charts for collapsed cards
  const card = document.querySelectorAll(".gpu-card")[gpuIndex];
  if (card && card.classList.contains("collapsed")) return;

  const h = gpuHistory[gpuIndex];
  if (!h) return;

  const memTotal = parseNumeric(gpu.memory.total) || 100;
  const powerLimit = parseNumeric(gpu.power.limit) || parseNumeric(gpu.power.max_limit) || 400;

  const chartDefs = [
    { id: `chart-util-${gpuIndex}`, label: "GPU 使用率", data: h.gpuUtil, color: "#76b900", max: 100, unit: "%" },
    { id: `chart-mem-${gpuIndex}`, label: "記憶體使用量", data: h.memUsed, color: "#4fc3f7", max: memTotal, unit: "MiB" },
    { id: `chart-temp-${gpuIndex}`, label: "溫度", data: h.temp, color: "#ffb74d", max: 100, unit: "\u00B0C" },
    { id: `chart-power-${gpuIndex}`, label: "功耗", data: h.power, color: "#ef5350", max: Math.ceil(powerLimit / 50) * 50, unit: "W" },
  ];

  if (!gpuCharts[gpuIndex]) gpuCharts[gpuIndex] = {};

  chartDefs.forEach((def) => {
    const canvas = document.getElementById(def.id);
    if (!canvas) return;

    if (gpuCharts[gpuIndex][def.id]) {
      const chart = gpuCharts[gpuIndex][def.id];
      chart.data.labels = h.labels;
      chart.data.datasets[0].data = def.data;
      chart.options.scales.y.max = def.max;
      chart.update("none");
    } else {
      const ctx = canvas.getContext("2d");
      gpuCharts[gpuIndex][def.id] = new Chart(
        ctx,
        createChartConfig(def.label, def.data, h.labels, def.color, def.max, def.unit)
      );
    }
  });
}

// ===== Render =====
function renderGPU(gpu, index, gpuCount) {
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

  pushHistory(index, gpuUtil, memUsed, temp, powerDraw);

  const collapsed = !isExpanded(index);
  const collapsedClass = collapsed ? " collapsed" : "";

  const fanDisplay =
    gpu.fan_speed && gpu.fan_speed !== "N/A"
      ? `<div style="text-align:right">
          <div style="font-size:13px;color:var(--text-secondary)">風扇轉速</div>
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
      : `<tr><td colspan="4" class="no-process">目前沒有執行中的程序</td></tr>`;

  return `
    <div class="gpu-card${collapsedClass}" data-gpu-index="${index}">
      <div class="gpu-card-header" onclick="toggleGpu(${index})">
        <div class="gpu-header-left">
          <div class="gpu-toggle">&#9660;</div>
          <div>
            <div class="gpu-name">GPU ${index}: ${gpu.name}</div>
            <div class="gpu-id">PCI Bus: ${gpu.pci.bus_id} | UUID: ${gpu.uuid.substring(0, 20)}...</div>
          </div>
        </div>
        <div class="gpu-header-right">
          <div class="gpu-summary">
            <div class="gpu-summary-item">
              <span class="summary-label">使用率</span>
              <span class="summary-val" style="color:var(--accent-green)" data-summary="util">${gpuUtil !== null ? gpuUtil + "%" : "--"}</span>
            </div>
            <div class="gpu-summary-item">
              <span class="summary-label">記憶體</span>
              <span class="summary-val" style="color:var(--accent-blue)" data-summary="mem">${memPct.toFixed(1)}%</span>
            </div>
            <div class="gpu-summary-item">
              <span class="summary-label">溫度</span>
              <span class="summary-val" style="color:var(--accent-orange)" data-summary="temp">${temp !== null ? temp + "\u00B0C" : "--"}</span>
            </div>
            <div class="gpu-summary-item">
              <span class="summary-label">功耗</span>
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
            <div class="metric-label">GPU 使用率</div>
            <div class="metric-value">${gpuUtil !== null ? gpuUtil + "%" : "--"}</div>
            <div class="metric-sub">圖形處理器負載</div>
          </div>
          <div class="metric-card blue">
            <div class="metric-label">記憶體使用量</div>
            <div class="metric-value">${memUsed !== null ? memUsed + " " + getUnit(gpu.memory.used) : "--"}</div>
            <div class="metric-sub">共 ${formatValue(gpu.memory.total)} (${memPct.toFixed(1)}%)</div>
          </div>
          <div class="metric-card orange">
            <div class="metric-label">溫度</div>
            <div class="metric-value">${temp !== null ? temp + "\u00B0C" : "--"}</div>
            <div class="metric-sub">降速閾值 ${formatValue(gpu.temperature.gpu_slowdown)}</div>
          </div>
          <div class="metric-card red">
            <div class="metric-label">功耗</div>
            <div class="metric-value">${powerDraw !== null ? powerDraw.toFixed(1) + " W" : "--"}</div>
            <div class="metric-sub">上限 ${formatValue(gpu.power.limit)}</div>
          </div>
        </div>

        <!-- Progress Bars -->
        <div class="progress-section">
          <div class="progress-header">
            <span class="progress-title">GPU 使用率</span>
            <span class="progress-value" style="color:var(--accent-green)">${gpuUtil !== null ? gpuUtil + "%" : "--"}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${getProgressColor(gpuUtil || 0)}" style="width:${gpuUtil || 0}%"></div>
          </div>
        </div>
        <div class="progress-section">
          <div class="progress-header">
            <span class="progress-title">記憶體使用率</span>
            <span class="progress-value" style="color:var(--accent-blue)">${memPct.toFixed(1)}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${getProgressColor(memPct)}" style="width:${memPct}%"></div>
          </div>
        </div>
        <div class="progress-section">
          <div class="progress-header">
            <span class="progress-title">溫度</span>
            <span class="progress-value" style="color:var(--accent-orange)">${temp !== null ? temp + "\u00B0C" : "--"}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${getProgressColor(tempPct)}" style="width:${tempPct}%"></div>
          </div>
        </div>
        <div class="progress-section">
          <div class="progress-header">
            <span class="progress-title">功耗</span>
            <span class="progress-value" style="color:var(--accent-red)">${powerDraw !== null ? powerDraw.toFixed(1) + " W" : "--"}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${getProgressColor(powerPct)}" style="width:${powerPct}%"></div>
          </div>
        </div>

        <!-- Charts -->
        <div class="charts-section">
          <div class="charts-title">歷史趨勢圖</div>
          <div class="charts-grid">
            <div class="chart-container">
              <div class="chart-label" style="color:var(--accent-green)">GPU 使用率 (%)</div>
              <div class="chart-wrapper"><canvas id="chart-util-${index}"></canvas></div>
            </div>
            <div class="chart-container">
              <div class="chart-label" style="color:var(--accent-blue)">記憶體使用量 (MiB)</div>
              <div class="chart-wrapper"><canvas id="chart-mem-${index}"></canvas></div>
            </div>
            <div class="chart-container">
              <div class="chart-label" style="color:var(--accent-orange)">溫度 (\u00B0C)</div>
              <div class="chart-wrapper"><canvas id="chart-temp-${index}"></canvas></div>
            </div>
            <div class="chart-container">
              <div class="chart-label" style="color:var(--accent-red)">功耗 (W)</div>
              <div class="chart-wrapper"><canvas id="chart-power-${index}"></canvas></div>
            </div>
          </div>
        </div>

        <!-- Detail Sections -->
        <div class="details-grid">
          <div class="detail-section">
            <div class="detail-section-title">&#9201; 時脈頻率</div>
            <div class="detail-row"><span class="detail-key">圖形時脈</span><span class="detail-val">${formatValue(gpu.clocks.graphics)}</span></div>
            <div class="detail-row"><span class="detail-key">SM 時脈</span><span class="detail-val">${formatValue(gpu.clocks.sm)}</span></div>
            <div class="detail-row"><span class="detail-key">記憶體時脈</span><span class="detail-val">${formatValue(gpu.clocks.memory)}</span></div>
          </div>
          <div class="detail-section">
            <div class="detail-section-title">&#9889; 使用率詳情</div>
            <div class="detail-row"><span class="detail-key">GPU 使用率</span><span class="detail-val">${formatValue(gpu.utilization.gpu)}</span></div>
            <div class="detail-row"><span class="detail-key">記憶體使用率</span><span class="detail-val">${formatValue(gpu.utilization.memory)}</span></div>
            <div class="detail-row"><span class="detail-key">編碼器</span><span class="detail-val">${formatValue(gpu.utilization.encoder)}</span></div>
            <div class="detail-row"><span class="detail-key">解碼器</span><span class="detail-val">${formatValue(gpu.utilization.decoder)}</span></div>
          </div>
          <div class="detail-section">
            <div class="detail-section-title">&#128268; PCI 資訊</div>
            <div class="detail-row"><span class="detail-key">Bus ID</span><span class="detail-val">${formatValue(gpu.pci.bus_id)}</span></div>
            <div class="detail-row"><span class="detail-key">PCIe 代數</span><span class="detail-val">Gen ${formatValue(gpu.pci.link_gen_current)}</span></div>
            <div class="detail-row"><span class="detail-key">連結寬度</span><span class="detail-val">${formatValue(gpu.pci.link_width_current)}</span></div>
          </div>
        </div>

        <!-- Processes -->
        <div class="process-section">
          <div class="process-section-title">&#128187; 執行中的程序 (${gpu.processes.length})</div>
          <table class="process-table">
            <thead>
              <tr>
                <th>PID</th>
                <th>類型</th>
                <th>程序名稱</th>
                <th>記憶體用量</th>
              </tr>
            </thead>
            <tbody>
              ${processRows}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderError(msg) {
  document.getElementById("gpu-container").innerHTML = `
    <div class="error-card">
      <h3>錯誤</h3>
      <p>${msg}</p>
    </div>
  `;
}

function renderLoading() {
  document.getElementById("gpu-container").innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <div>正在載入 GPU 資訊...</div>
    </div>
  `;
}

// ===== Data Fetch & Update =====
let initialized = false;
let lastData = null;

async function fetchData() {
  try {
    const resp = await fetch("/api/gpu");
    const data = await resp.json();

    if (data.error) {
      renderError(data.error + (data.detail ? ": " + data.detail : ""));
      return;
    }

    lastData = data;
    totalGpuCount = data.gpus.length;

    // Update header
    document.getElementById("driver-version").textContent = data.driver_version || "--";
    document.getElementById("cuda-version").textContent = data.cuda_version || "--";
    document.getElementById("gpu-count").textContent = data.gpus.length + " GPU";

    const now = new Date();
    document.getElementById("last-update").textContent = "最後更新: " + now.toLocaleTimeString("zh-TW");

    const container = document.getElementById("gpu-container");
    if (!initialized || container.querySelectorAll(".gpu-card").length !== data.gpus.length) {
      // Destroy old charts
      Object.values(gpuCharts).forEach((charts) => {
        Object.values(charts).forEach((c) => c.destroy());
      });
      Object.keys(gpuCharts).forEach((k) => delete gpuCharts[k]);

      container.innerHTML = data.gpus.map((gpu, i) => renderGPU(gpu, i, data.gpus.length)).join("");

      // Create charts for expanded cards
      data.gpus.forEach((gpu, i) => createOrUpdateCharts(i, gpu));
      initialized = true;
    } else {
      data.gpus.forEach((gpu, i) => {
        updateGPUMetrics(gpu, i);
        createOrUpdateCharts(i, gpu);
      });
    }
  } catch (err) {
    renderError("無法連線至伺服器: " + err.message);
  }
}

function updateGPUMetrics(gpu, index) {
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

  pushHistory(index, gpuUtil, memUsed, temp, powerDraw);

  const card = document.querySelectorAll(".gpu-card")[index];
  if (!card) return;

  // Update summary (always visible when collapsed)
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
  if (metricSubs[1]) metricSubs[1].textContent = "共 " + formatValue(gpu.memory.total) + " (" + memPct.toFixed(1) + "%)";
  if (metricSubs[3]) metricSubs[3].textContent = "上限 " + formatValue(gpu.power.limit);

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
        : `<tr><td colspan="4" class="no-process">目前沒有執行中的程序</td></tr>`;
  }

  const procTitle = card.querySelector(".process-section-title");
  if (procTitle) procTitle.innerHTML = `&#128187; 執行中的程序 (${gpu.processes.length})`;
}

// Initial load
renderLoading();
fetchData();
setInterval(fetchData, REFRESH_INTERVAL);
