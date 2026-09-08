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

    // Render Waveform
    ppgCtx.beginPath();
    const dx = width / (ppgBuffer.length - 1);

    for (let i = 0; i < ppgBuffer.length; i++) {
        // Invert optical sign: MAX30102 AC drops during pulse absorption, so invert to show positive systolic peak
        const y = centerY - (ppgBuffer[i] * scaleY);
        const x = i * dx;
        if (i === 0) {
            ppgCtx.moveTo(x, y);
        } else {
            ppgCtx.lineTo(x, y);
        }
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
}, (error) => {
    connectionDot.className = "dot";
    connectionStatus.textContent = "Error connecting to Firebase: " + error.message;
});
