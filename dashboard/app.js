const firebaseConfig = {
    apiKey: "AIzaSyAjOQrTXuuqDcnNf4UP2aXBy17JvpdD2xI",
    authDomain: "esp-project-114dd.firebaseapp.com",
    databaseURL: "https://esp-project-114dd-default-rtdb.firebaseio.com",
    projectId: "esp-project-114dd",
    storageBucket: "esp-project-114dd.firebasestorage.app",
    messagingSenderId: "685391999885",
    appId: "1:685391999885:web:6dfdc5f5279fcaa47303c4",
    measurementId: "G-QY3N6JL2Q1"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// DOM Elements
const bpmVal = document.getElementById('bpm-val');
const spo2Val = document.getElementById('spo2-val');
const respVal = document.getElementById('resp-val');
const bpmStatus = document.getElementById('bpm-status');
const spo2Status = document.getElementById('spo2-status');
const respStatus = document.getElementById('resp-status');
const connectionDot = document.getElementById('connection-dot');
const connectionStatus = document.getElementById('connection-status');
const fingerBanner = document.getElementById('finger-banner');

// PPG Plethysmogram Oscilloscope Elements
const ppgCanvas = document.getElementById('ppgCanvas');
const ppgCtx = ppgCanvas ? ppgCanvas.getContext('2d') : null;
const pulseDot = document.getElementById('pulse-dot');
const plethRate = document.getElementById('pleth-rate');
const flatlineOverlay = document.getElementById('flatline-overlay');

// Telemetry Session & Export Elements
const btnExportCSV = document.getElementById('btn-export-csv');
const btnExportPDF = document.getElementById('btn-export-pdf');
const btnClearRecords = document.getElementById('btn-clear-records');
const logCountBadge = document.getElementById('log-count-badge');
const printableReport = document.getElementById('printable-report');
const sessionSelect = document.getElementById('session-select');
const btnNewSession = document.getElementById('btn-new-session');

// Patient Session Management (Isolates telemetry per individual patient)
let sessionCounter = 1;
let activeSession = {
    id: 1,
    name: "Patient Session #1",
    startTime: null,
    endTime: null,
    date: new Date().toLocaleDateString(),
    records: []
};
const allSessions = [activeSession];
let sessionConcludedOnFingerLift = false;

function getSelectedSession() {
    if (!sessionSelect) return activeSession;
    const selectedId = parseInt(sessionSelect.value, 10);
    return allSessions.find(s => s.id === selectedId) || activeSession || allSessions[allSessions.length - 1];
}

function updateBadgeForSelectedSession() {
    const s = getSelectedSession();
    if (!logCountBadge || !s) return;
    const count = s.records.length;
    logCountBadge.textContent = `${count} record${count === 1 ? '' : 's'}`;
}

function updateSessionDropdown() {
    if (!sessionSelect) return;
    const currentSelectedId = parseInt(sessionSelect.value, 10);
    sessionSelect.innerHTML = "";

    allSessions.forEach(session => {
        const opt = document.createElement("option");
        opt.value = session.id;
        const isActive = (activeSession && session.id === activeSession.id);
        const count = session.records.length;
        const timeInfo = session.startTime ? ` (${session.startTime}${session.endTime ? ' - ' + session.endTime : ''})` : '';
        opt.textContent = `${session.name}${isActive ? ' (Active)' : ' (Saved)'} - ${count} records${timeInfo}`;
        sessionSelect.appendChild(opt);
    });

    if (activeSession) {
        sessionSelect.value = activeSession.id;
    } else if (allSessions.length > 0) {
        sessionSelect.value = allSessions[allSessions.length - 1].id;
    }
    updateBadgeForSelectedSession();
}

function startNewPatientSession() {
    if (activeSession && activeSession.records.length > 0 && !activeSession.endTime) {
        activeSession.endTime = new Date().toLocaleTimeString();
    }
    sessionCounter++;
    activeSession = {
        id: sessionCounter,
        name: `Patient Session #${sessionCounter}`,
        startTime: null,
        endTime: null,
        date: new Date().toLocaleDateString(),
        records: []
    };
    allSessions.push(activeSession);
    sessionConcludedOnFingerLift = false;

    // Reset chart for new patient
    vitalsChart.data.labels = [];
    vitalsChart.data.datasets[0].data = [];
    vitalsChart.data.datasets[1].data = [];
    vitalsChart.data.datasets[2].data = [];
    vitalsChart.update();

    updateSessionDropdown();
}

// Plethysmogram Waveform Buffer & Interpolation Queue
const WAVE_BUFFER_SIZE = 220; // Number of display points across canvas width
const ppgBuffer = new Array(WAVE_BUFFER_SIZE).fill(0);
let ppgIncomingQueue = [];
let isFingerPresent = false;
let currentDynamicRange = 100.0; // Dynamic AGC for autoscaling waveform height
let lastBeatPulseTime = 0;

// Chart Setup
const ctx = document.getElementById('vitalsChart').getContext('2d');
const maxDataPoints = 30; // Last 30 points

const vitalsChart = new Chart(ctx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            {
                label: 'Heart Rate (BPM)',
                data: [],
                borderColor: '#e74c3c',
                backgroundColor: 'rgba(231, 76, 60, 0.1)',
                borderWidth: 2.5,
                yAxisID: 'y',
                tension: 0.35,
                pointRadius: 4
            },
            {
                label: 'SpO2 (%)',
                data: [],
                borderColor: '#2980b9',
                backgroundColor: 'rgba(41, 128, 185, 0.1)',
                borderWidth: 2.5,
                yAxisID: 'y1',
                tension: 0.35,
                pointRadius: 4
            },
            {
                label: 'Respiration Rate (BrPM)',
                data: [],
                borderColor: '#27ae60',
                backgroundColor: 'rgba(39, 174, 96, 0.1)',
                borderWidth: 2.5,
                yAxisID: 'y2',
                tension: 0.35,
                pointRadius: 4
            }
        ]
    },
    options: {
        responsive: true,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        scales: {
            x: {
                display: true,
                title: { display: true, text: 'Time', font: { weight: 'bold' } },
                grid: { display: false }
            },
            y: {
                type: 'linear',
                display: true,
                position: 'left',
                title: { display: true, text: 'BPM', font: { weight: 'bold', color: '#e74c3c' } },
                min: 40,
                max: 160
            },
            y1: {
                type: 'linear',
                display: true,
                position: 'right',
                title: { display: true, text: 'SpO2 %', font: { weight: 'bold', color: '#2980b9' } },
                min: 80,
                max: 100,
                grid: { drawOnChartArea: false }
            },
            y2: {
                type: 'linear',
                display: false,
                min: 0,
                max: 40
            }
        }
    }
});

function setIdleState(message) {
    isFingerPresent = false;
    fingerBanner.style.display = "block";
    if (message) fingerBanner.textContent = message;
    connectionDot.className = "dot warning";
    connectionStatus.textContent = "Sensor Online: No Finger Detected";

    bpmVal.textContent = "--";
    spo2Val.textContent = "--";
    respVal.textContent = "--";

    bpmStatus.textContent = "No Finger";
    bpmStatus.className = "status-indicator status-idle";
    spo2Status.textContent = "No Finger";
    spo2Status.className = "status-indicator status-idle";
    respStatus.textContent = "No Finger";
    respStatus.className = "status-indicator status-idle";

    if (plethRate) plethRate.textContent = "PULSE: --";
    if (flatlineOverlay) flatlineOverlay.style.display = "block";
    if (pulseDot) pulseDot.classList.remove("active");
    ppgIncomingQueue = [];
    ppgBuffer.fill(0);

    // If active session was recording, conclude it upon finger removal
    if (activeSession && activeSession.records.length > 0) {
        if (!activeSession.endTime) {
            activeSession.endTime = new Date().toLocaleTimeString();
        }
        sessionConcludedOnFingerLift = true;
        updateSessionDropdown();
    }
}

function evaluateVitals(bpm, spo2, resp) {
    fingerBanner.style.display = "none";
    connectionDot.className = "dot online";
    connectionStatus.textContent = "Live Cloud Stream Active (Resting Vitals Steady)";

    // Heart Rate Evaluation
    if (bpm < 50) {
        bpmStatus.textContent = "Bradycardia";
        bpmStatus.className = "status-indicator status-warning";
    } else if (bpm > 105) {
        bpmStatus.textContent = "Elevated";
        bpmStatus.className = "status-indicator status-warning";
    } else {
        bpmStatus.textContent = "Normal (Resting)";
        bpmStatus.className = "status-indicator status-normal";
    }

    // SpO2 Evaluation
    if (spo2 < 93) {
        spo2Status.textContent = "Low Oxygen";
        spo2Status.className = "status-indicator status-warning";
    } else {
        spo2Status.textContent = "Normal";
        spo2Status.className = "status-indicator status-normal";
    }

    // Respiration Rate Evaluation
    if (resp < 10 || resp > 24) {
        respStatus.textContent = resp < 10 ? "Bradypnea" : "Tachypnea";
        respStatus.className = "status-indicator status-warning";
    } else {
        respStatus.textContent = "Normal";
        respStatus.className = "status-indicator status-normal";
    }
}

// ----------------------------------------------------
// Clinical Plethysmogram Oscilloscope Render Engine
// ----------------------------------------------------
function drawGrid(width, height) {
    if (!ppgCtx) return;
    ppgCtx.strokeStyle = "rgba(0, 245, 212, 0.07)";
    ppgCtx.lineWidth = 1;
    const step = 25;

    ppgCtx.beginPath();
    for (let x = 0; x <= width; x += step) {
        ppgCtx.moveTo(x, 0);
        ppgCtx.lineTo(x, height);
    }
    for (let y = 0; y <= height; y += step) {
        ppgCtx.moveTo(0, y);
        ppgCtx.lineTo(width, y);
    }
    ppgCtx.stroke();

    // Subtle horizontal baseline
    ppgCtx.strokeStyle = "rgba(0, 245, 212, 0.18)";
    ppgCtx.beginPath();
    ppgCtx.moveTo(0, height / 2);
    ppgCtx.lineTo(width, height / 2);
    ppgCtx.stroke();
}

let lastFrameTime = performance.now();
let sampleAccumulator = 0;

function renderOscilloscope(currentTime) {
    requestAnimationFrame(renderOscilloscope);

    if (!ppgCanvas || !ppgCtx) return;

    const width = ppgCanvas.width;
    const height = ppgCanvas.height;
    const centerY = height / 2;

    const dt = Math.min((currentTime - lastFrameTime) / 1000, 0.1); // Guard against tab background tab switches
    lastFrameTime = currentTime;

    // Drain incoming queue at optical sensor sample rate (~40-50 Hz)
    const SAMPLES_PER_SEC = 45;
    sampleAccumulator += dt * SAMPLES_PER_SEC;

    while (sampleAccumulator >= 1.0) {
        sampleAccumulator -= 1.0;
        let nextSample = 0;
        if (isFingerPresent && ppgIncomingQueue.length > 0) {
            nextSample = ppgIncomingQueue.shift();
        } else if (!isFingerPresent) {
            nextSample = 0;
        } else {
            // Buffer hold with smooth decay if queue is waiting for next packet
            nextSample = ppgBuffer[ppgBuffer.length - 1] * 0.94;
        }
        ppgBuffer.push(nextSample);
        ppgBuffer.shift();

        // Detect systolic blip on upstroke for pulsing dot
        if (isFingerPresent && nextSample > currentDynamicRange * 0.40) {
            const now = performance.now();
            if (now - lastBeatPulseTime > 320) {
                lastBeatPulseTime = now;
                if (pulseDot) {
                    pulseDot.classList.add("active");
                    setTimeout(() => pulseDot.classList.remove("active"), 160);
                }
            }
        }
    }

    // Auto Gain Control (Dynamic Range estimation)
    let maxAbs = 40;
    for (let i = 0; i < ppgBuffer.length; i++) {
        const val = Math.abs(ppgBuffer[i]);
        if (val > maxAbs) maxAbs = val;
    }
    currentDynamicRange = currentDynamicRange * 0.97 + maxAbs * 0.03;
    const scaleY = currentDynamicRange > 5 ? (height * 0.38) / currentDynamicRange : 1.0;

    // Clear canvas with deep dark medical monitor background
    ppgCtx.fillStyle = "#090d16";
    ppgCtx.fillRect(0, 0, width, height);

    // Draw Grid
    drawGrid(width, height);

    // Render Catmull-Rom Cubic Bezier Spline Waveform
    const pts = [];
    const dx = width / (ppgBuffer.length - 1);
    for (let i = 0; i < ppgBuffer.length; i++) {
        // Invert optical sign: MAX30102 AC drops during pulse absorption, so invert to show positive systolic peak
        pts.push({
            x: i * dx,
            y: centerY - (ppgBuffer[i] * scaleY)
        });
    }

    ppgCtx.beginPath();
    ppgCtx.moveTo(pts[0].x, pts[0].y);

    // Compute Catmull-Rom cubic Bezier spline through all points
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = i > 0 ? pts[i - 1] : pts[i];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = i < pts.length - 2 ? pts[i + 2] : p2;

        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;

        ppgCtx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }

    // Glowing stroke
    ppgCtx.strokeStyle = isFingerPresent ? "#00f5d4" : "rgba(239, 68, 68, 0.6)";
    ppgCtx.lineWidth = 2.4;
    ppgCtx.shadowColor = isFingerPresent ? "#00f5d4" : "rgba(239, 68, 68, 0.4)";
    ppgCtx.shadowBlur = 10;
    ppgCtx.stroke();

    // Area fill under wave for medical monitor look
    if (isFingerPresent) {
        ppgCtx.lineTo(width, height);
        ppgCtx.lineTo(0, height);
        ppgCtx.closePath();
        const gradient = ppgCtx.createLinearGradient(0, centerY - 40, 0, height);
        gradient.addColorStop(0, "rgba(0, 245, 212, 0.12)");
        gradient.addColorStop(1, "rgba(0, 245, 212, 0.0)");
        ppgCtx.fillStyle = gradient;
        ppgCtx.shadowBlur = 0;
        ppgCtx.fill();
    }

    // Leading Sweep Dot
    const lastY = centerY - (ppgBuffer[ppgBuffer.length - 1] * scaleY);
    ppgCtx.beginPath();
    ppgCtx.arc(width - 2, lastY, 4, 0, 2 * Math.PI);
    ppgCtx.fillStyle = isFingerPresent ? "#ffffff" : "#ef4444";
    ppgCtx.shadowColor = isFingerPresent ? "#00f5d4" : "#ef4444";
    ppgCtx.shadowBlur = 12;
    ppgCtx.fill();
    ppgCtx.shadowBlur = 0;
}

// Start Oscilloscope Render Loop immediately
requestAnimationFrame(renderOscilloscope);

// Listen for live updates from Firebase RTDB
database.ref('vitals/current').on('value', (snapshot) => {
    const data = snapshot.val();
    if (!data) return;

    // Check Finger Detection State
    if (data.fingerDetected === false) {
        setIdleState("⚠️ NO FINGER DETECTED — Place your finger lightly and steadily on the MAX30102 sensor.");
        return;
    }

    // Finger is detected!
    isFingerPresent = true;
    if (flatlineOverlay) flatlineOverlay.style.display = "none";

    // Handle PPG Waveform Streaming
    if (Array.isArray(data.ppgWave) && data.ppgWave.length > 0) {
        // Prevent queue accumulation if tab was backgrounded
        if (ppgIncomingQueue.length > 80) {
            ppgIncomingQueue = ppgIncomingQueue.slice(-40);
        }
        ppgIncomingQueue.push(...data.ppgWave);
    }

    // Finger is detected, but vitals are stabilizing
    if (!data.bpm || data.bpm === 0) {
        fingerBanner.style.display = "block";
        fingerBanner.textContent = "⏳ FINGER DETECTED — Calibrating optical signal and computing vitals...";
        fingerBanner.style.background = "#fff3cd";
        fingerBanner.style.color = "#856404";
        fingerBanner.style.border = "1px solid #ffeeba";
        connectionDot.className = "dot online";
        connectionStatus.textContent = "Sensor Online: Finger Detected (Acquiring Vitals...)";
        bpmVal.textContent = "--";
        spo2Val.textContent = "--";
        respVal.textContent = "--";
        bpmStatus.textContent = "Acquiring";
        bpmStatus.className = "status-indicator status-idle";
        spo2Status.textContent = "Acquiring";
        spo2Status.className = "status-indicator status-idle";
        respStatus.textContent = "Acquiring";
        respStatus.className = "status-indicator status-idle";
        if (plethRate) plethRate.textContent = "PULSE: ACQUIRING...";
        return;
    }

    // Valid finger reading
    const bpm = Math.round(data.bpm);
    const spo2 = Math.round(data.spo2);
    const resp = data.respiration ? Math.round(data.respiration) : 15;

    bpmVal.textContent = bpm;
    spo2Val.textContent = spo2;
    respVal.textContent = resp;
    if (plethRate) plethRate.textContent = `PULSE: ${bpm} BPM`;

    evaluateVitals(bpm, spo2, resp);

    // Plot on chart only if valid
    const timeLabel = new Date((data.timestamp || Date.now() / 1000) * 1000).toLocaleTimeString();

    vitalsChart.data.labels.push(timeLabel);
    vitalsChart.data.datasets[0].data.push(bpm);
    vitalsChart.data.datasets[1].data.push(spo2);
    vitalsChart.data.datasets[2].data.push(resp);

    if (vitalsChart.data.labels.length > maxDataPoints) {
        vitalsChart.data.labels.shift();
        vitalsChart.data.datasets[0].data.shift();
        vitalsChart.data.datasets[1].data.shift();
        vitalsChart.data.datasets[2].data.shift();
    }

    vitalsChart.update();

    // Check if we need to start a new session for a new person (because previous finger was removed)
    if (sessionConcludedOnFingerLift) {
        sessionConcludedOnFingerLift = false;
        sessionCounter++;
        activeSession = {
            id: sessionCounter,
            name: `Patient Session #${sessionCounter}`,
            startTime: new Date().toLocaleTimeString(),
            endTime: null,
            date: new Date().toLocaleDateString(),
            records: []
        };
        allSessions.push(activeSession);

        // Clear previous patient's trend lines from the chart for fresh patient view
        vitalsChart.data.labels = [];
        vitalsChart.data.datasets[0].data = [];
        vitalsChart.data.datasets[1].data = [];
        vitalsChart.data.datasets[2].data = [];
        vitalsChart.update();

        updateSessionDropdown();
    }

    if (activeSession && !activeSession.startTime) {
        activeSession.startTime = new Date().toLocaleTimeString();
    }

    // Accumulate in ACTIVE patient session (avoid duplicate consecutive records)
    const nowEpoch = data.timestamp ? Math.round(data.timestamp) : Math.round(Date.now() / 1000);
    const sessionRecords = activeSession.records;
    const lastRecord = sessionRecords[sessionRecords.length - 1];
    if (!lastRecord || lastRecord.epoch !== nowEpoch || lastRecord.bpm !== bpm || lastRecord.spo2 !== spo2) {
        sessionRecords.push({
            id: sessionRecords.length + 1,
            epoch: nowEpoch,
            isoTime: new Date(nowEpoch * 1000).toISOString(),
            localTime: new Date(nowEpoch * 1000).toLocaleTimeString(),
            bpm: bpm,
            spo2: spo2,
            respiration: resp,
            statusHR: bpm < 50 ? "Bradycardia" : bpm > 105 ? "Elevated" : "Normal",
            statusSpO2: spo2 < 93 ? "Low Oxygen" : "Normal",
            statusRR: resp < 10 ? "Bradypnea" : resp > 24 ? "Tachypnea" : "Normal"
        });
        updateSessionDropdown();
        updateBadgeForSelectedSession();
    }
}, (error) => {
    connectionDot.className = "dot";
    connectionStatus.textContent = "Error connecting to Firebase: " + error.message;
});

// ----------------------------------------------------
// Telemetry Data Export Handlers (Per-Patient Session)
// ----------------------------------------------------
function exportCSV() {
    const session = getSelectedSession();
    if (!session || session.records.length === 0) {
        alert("No clinical telemetry records have been logged for this patient session yet.");
        return;
    }

    const headers = [
        "Record ID",
        "Timestamp (ISO)",
        "Local Time",
        "Heart Rate (BPM)",
        "SpO2 (%)",
        "Respiration Rate (BrPM)",
        "Heart Rate Evaluation",
        "SpO2 Evaluation",
        "Respiration Evaluation"
    ];

    const meta = [
        `"Session","${session.name}"`,
        `"Session Date","${session.date || new Date().toLocaleDateString()}"`,
        `"Start Time","${session.startTime || '--'}"`,
        `"End Time","${session.endTime || 'Active'}"`,
        `"Total Session Samples",${session.records.length}`,
        ""
    ];

    const csvRows = [...meta, headers.join(",")];

    for (const r of session.records) {
        const row = [
            r.id,
            `"${r.isoTime}"`,
            `"${r.localTime}"`,
            r.bpm,
            r.spo2,
            r.respiration,
            `"${r.statusHR}"`,
            `"${r.statusSpO2}"`,
            `"${r.statusRR}"`
        ];
        csvRows.push(row.join(","));
    }

    const csvBlob = new Blob([csvRows.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(csvBlob);
    const a = document.createElement("a");
    const safeName = session.name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `${safeName}_vitals_${dateStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function exportPDFReport() {
    const session = getSelectedSession();
    if (!session || session.records.length === 0) {
        alert("No clinical telemetry records have been logged for this patient session yet.");
        return;
    }

    // Compute Summary Statistics ONLY for this individual patient session
    let sumBpm = 0, minBpm = Infinity, maxBpm = -Infinity;
    let sumSpo2 = 0, minSpo2 = Infinity, maxSpo2 = -Infinity;
    let sumResp = 0, minResp = Infinity, maxResp = -Infinity;

    for (const r of session.records) {
        sumBpm += r.bpm;
        if (r.bpm < minBpm) minBpm = r.bpm;
        if (r.bpm > maxBpm) maxBpm = r.bpm;

        sumSpo2 += r.spo2;
        if (r.spo2 < minSpo2) minSpo2 = r.spo2;
        if (r.spo2 > maxSpo2) maxSpo2 = r.spo2;

        sumResp += r.respiration;
        if (r.respiration < minResp) minResp = r.respiration;
        if (r.respiration > maxResp) maxResp = r.respiration;
    }

    const avgBpm = Math.round(sumBpm / session.records.length);
    const avgSpo2 = Math.round(sumSpo2 / session.records.length);
    const avgResp = Math.round(sumResp / session.records.length);

    const firstTime = session.startTime || session.records[0].localTime;
    const lastTime = session.endTime || session.records[session.records.length - 1].localTime;
    const sessionDate = session.date || new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    let rowsHtml = "";
    // Display all or up to 60 records for the patient
    const displayEntries = session.records.slice(-60);
    for (const r of displayEntries) {
        rowsHtml += `
            <tr>
                <td>${r.id}</td>
                <td>${r.localTime}</td>
                <td><strong>${r.bpm}</strong> BPM (${r.statusHR})</td>
                <td><strong>${r.spo2}</strong>% (${r.statusSpO2})</td>
                <td><strong>${r.respiration}</strong> BrPM (${r.statusRR})</td>
            </tr>
        `;
    }

    const reportHtml = `
        <div class="print-header">
            <div>
                <h1>Hospital Remote Patient Monitoring System</h1>
                <div class="subtitle">INDIVIDUAL PATIENT TELEMETRY REPORT — ${session.name.toUpperCase()}</div>
            </div>
            <div style="text-align: right; font-size: 0.8rem; color: #64748b;">
                <div><strong>CONFIDENTIAL MEDICAL RECORD</strong></div>
                <div>Generated: ${new Date().toLocaleTimeString()}</div>
            </div>
        </div>

        <div class="print-meta-grid">
            <div class="print-meta-item">
                <div><strong>Patient Identifier:</strong> ${session.name}</div>
                <div><strong>Session Date:</strong> ${sessionDate}</div>
            </div>
            <div class="print-meta-item">
                <div><strong>Recording Window:</strong> ${firstTime} - ${lastTime}</div>
                <div><strong>Device:</strong> ESP32 MAX30102 Optical PPG</div>
            </div>
            <div class="print-meta-item">
                <div><strong>Session Samples:</strong> ${session.records.length} records</div>
                <div><strong>Status:</strong> ${session.endTime ? 'Completed' : 'In Progress'}</div>
            </div>
        </div>

        <div class="print-summary-cards">
            <div class="print-stat-card">
                <h3>Heart Rate (BPM)</h3>
                <div class="stat-row"><span>Mean (Average):</span> <strong>${avgBpm} BPM</strong></div>
                <div class="stat-row"><span>Range (Min - Max):</span> <span>${minBpm} - ${maxBpm} BPM</span></div>
                <div class="stat-row"><span>Reference:</span> <span style="color:#0284c7">60 - 100 BPM</span></div>
            </div>
            <div class="print-stat-card">
                <h3>Blood Oxygen (SpO2)</h3>
                <div class="stat-row"><span>Mean (Average):</span> <strong>${avgSpo2}%</strong></div>
                <div class="stat-row"><span>Range (Min - Max):</span> <span>${minSpo2}% - ${maxSpo2}%</span></div>
                <div class="stat-row"><span>Reference:</span> <span style="color:#0284c7">&ge; 95%</span></div>
            </div>
            <div class="print-stat-card">
                <h3>Respiration Rate</h3>
                <div class="stat-row"><span>Mean (Average):</span> <strong>${avgResp} BrPM</strong></div>
                <div class="stat-row"><span>Range (Min - Max):</span> <span>${minResp} - ${maxResp} BrPM</span></div>
                <div class="stat-row"><span>Reference:</span> <span style="color:#0284c7">12 - 20 BrPM</span></div>
            </div>
        </div>

        <h3 style="font-size: 1rem; color: #0f172a; margin: 20px 0 8px 0;">Patient Telemetric Data Log ${session.records.length > 60 ? '(Last 60 Records)' : ''}</h3>
        <table class="print-table">
            <thead>
                <tr>
                    <th>#</th>
                    <th>Time</th>
                    <th>Heart Rate</th>
                    <th>SpO2</th>
                    <th>Respiration</th>
                </tr>
            </thead>
            <tbody>
                ${rowsHtml}
            </tbody>
        </table>

        <div class="print-footer">
            <div>Physiological algorithm: Dual-Core ESP32 FreeRTOS (Autocorrelation + Ratio-of-Ratios)</div>
            <div>Attending Clinician Signature: ___________________________</div>
        </div>
    `;

    if (printableReport) {
        printableReport.innerHTML = reportHtml;
    }

    // Open native browser print dialog (supports Save as PDF or physical print)
    window.print();
}

if (btnExportCSV) {
    btnExportCSV.addEventListener('click', exportCSV);
}
if (btnExportPDF) {
    btnExportPDF.addEventListener('click', exportPDFReport);
}
if (btnClearRecords) {
    btnClearRecords.addEventListener('click', clearAllPatientRecords);
}
if (sessionSelect) {
    sessionSelect.addEventListener('change', () => {
        updateBadgeForSelectedSession();
        const s = getSelectedSession();
        if (s && s.records.length > 0) {
            vitalsChart.data.labels = s.records.map(r => r.localTime);
            vitalsChart.data.datasets[0].data = s.records.map(r => r.bpm);
            vitalsChart.data.datasets[1].data = s.records.map(r => r.spo2);
            vitalsChart.data.datasets[2].data = s.records.map(r => r.respiration);
            vitalsChart.update();
        }
    });
}
if (btnNewSession) {
    btnNewSession.addEventListener('click', startNewPatientSession);
}

function clearAllPatientRecords() {
    const totalRecords = allSessions.reduce((acc, s) => acc + s.records.length, 0);
    if (totalRecords === 0) {
        alert("There are no patient records to clear.");
        return;
    }

    const confirmed = confirm(`Are you sure you want to clear all ${totalRecords} patient records across ${allSessions.length} session(s)? This action cannot be undone.`);
    if (!confirmed) return;

    // Reset session counter and sessions list
    sessionCounter = 1;
    activeSession = {
        id: 1,
        name: "Patient Session #1",
        startTime: null,
        endTime: null,
        date: new Date().toLocaleDateString(),
        records: []
    };
    allSessions.length = 0;
    allSessions.push(activeSession);
    sessionConcludedOnFingerLift = false;

    // Reset trend chart
    vitalsChart.data.labels = [];
    vitalsChart.data.datasets[0].data = [];
    vitalsChart.data.datasets[1].data = [];
    vitalsChart.data.datasets[2].data = [];
    vitalsChart.update();

    // Clear printable report if rendered
    if (printableReport) {
        printableReport.innerHTML = "";
    }

    // Refresh UI dropdown & badge
    updateSessionDropdown();
    updateBadgeForSelectedSession();
}
