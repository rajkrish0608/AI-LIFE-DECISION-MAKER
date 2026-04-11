/* =======================================
   1. STATE & PERSISTENCE
======================================= */
let appState = {
    onboarded: false,
    prefs: { goal: 'productivity', diet: 'none', budget: 'med' },
    stats: { total: 0, accepted: 0, streak: 0, timeSavedMins: 0 },
    history: [], // { id, cat, cmd, status: 'accepted'|'rejected', ts }
    mode: 'standard', // 'standard' | 'extreme'
    firstUsed: null
};

let activeCategory = 'all';
let currentDecision = null; // { id, cat, text, exp, conf, isLife, rejected: [{text, reason}] }

let contextData = {
    timeBlock: 'day', // morning, day, evening, night
    weather: { temp: 22, condition: 'Clear', valid: false },
    location: 'Unknown Sector',
    usingFallback: true
};

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.error("SW Reg failed:", err));
    });
}

function saveState() {
    localStorage.setItem('aidm_state', JSON.stringify(appState));
    updateDashboardUI();
}

function loadState() {
    const saved = localStorage.getItem('aidm_state');
    if (saved) {
        appState = { ...appState, ...JSON.parse(saved) };
    }
    if (!appState.firstUsed) {
        appState.firstUsed = Date.now();
        saveState();
    }
}

/* =======================================
   2. CONTEXT AWARENESS & FALLBACKS
======================================= */
async function gatherContext() {
    // 1. Time Logic
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 11) contextData.timeBlock = 'morning';
    else if (hour >= 11 && hour < 16) contextData.timeBlock = 'day';
    else if (hour >= 16 && hour < 22) contextData.timeBlock = 'evening';
    else contextData.timeBlock = 'night';

    const timeStr = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    document.getElementById('ctx-time').innerHTML = `<i class='bx bx-time'></i> ${timeStr}`;

    // Update fallback UI state initially
    document.getElementById('ctx-weather').innerHTML = `<i class='bx bx-cloud'></i> Fetching...`;
    document.getElementById('ctx-loc').innerHTML = `<i class='bx bx-map-pin'></i> Locating...`;
    document.getElementById('fallback-warning').classList.add('hidden');

    // 2. Geolocation & Weather
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;
                contextData.location = "Local Sector Validated";
                document.getElementById('ctx-loc').innerHTML = `<i class='bx bx-map-pin'></i> ${contextData.location}`;
                
                try {
                    // Call SECURE Backend Proxy
                    const res = await fetch(`/api/weather?lat=${lat}&lon=${lon}`);
                    if(!res.ok) throw new Error("API Failure");
                    const data = await res.json();
                    
                    contextData.weather = { temp: Math.round(data.main.temp), condition: data.weather[0].main, valid: true };
                    contextData.usingFallback = false;
                    document.getElementById('ctx-weather').innerHTML = `<i class='bx bx-cloud'></i> ${contextData.weather.temp}°C, ${contextData.weather.condition}`;
                    document.getElementById('fallback-warning').classList.add('hidden');
                } catch(e) {
                    applyFallbackContext();
                }
            },
            (error) => {
                applyFallbackContext(); // Permission denied or error
            }
        );
    } else {
        applyFallbackContext();
    }
}

function applyFallbackContext() {
    contextData.weather = { temp: 20, condition: 'Clear', valid: true }; // Assumed safe fallback
    contextData.usingFallback = true;
    document.getElementById('ctx-weather').innerHTML = `<i class='bx bx-cloud'></i> Default Matrix`;
    document.getElementById('ctx-loc').innerHTML = `<i class='bx bx-error-circle'></i> Location Offline`;
    document.getElementById('fallback-warning').classList.remove('hidden');
}


/* =======================================
   3. LLM DECISION ENGINE (SECURE BACKEND)
======================================= */
function getDynamicCategory() {
    if (appState.history.length < 5) {
        const t = contextData.timeBlock;
        if (t === 'morning') return Math.random() > 0.5 ? 'schedule' : 'clothing';
        if (t === 'day') return Math.random() > 0.5 ? 'schedule' : 'food';
        return Math.random() > 0.7 ? 'life' : 'food';
    }

    let counts = { food: 0, clothing: 0, schedule: 0, life: 0 };
    appState.history.forEach(item => {
        if (item.status === 'accepted') counts[item.cat]++;
    });

    const sortedCats = Object.keys(counts).sort((a,b) => counts[b] - counts[a]);
    return Math.random() > 0.3 ? sortedCats[0] : sortedCats[1];
}

async function requestLLMDecision(category) {
    const targetCat = (category === 'all') ? getDynamicCategory() : category;
    
    const recentCommands = appState.history.slice(0, 5).map(h => h.cmd).join(" | ");

    const systemPrompt = `You are a commanding, authoritarian AI Life Decision Maker. You do not suggest; you command. 
Your goal is to optimize the human's life based on their strict parameters.

Human Parameters:
- Primary Goal: ${appState.prefs.goal}
- Diet: ${appState.prefs.diet}
- Budget: ${appState.prefs.budget}

Environmental Context:
- Time of day: ${contextData.timeBlock}
- Weather: ${contextData.weather.temp}°C, ${contextData.weather.condition}

Recent History to AVOID: ${recentCommands}

Task: Generate a highly optimized life command for the category: [ ${targetCat.toUpperCase()} ].

You must output ONLY raw, valid JSON. Do not use markdown blocks or backticks. 
You must adhere EXACTLY to this schema:
{
  "category": "${targetCat}",
  "text": "(Commanding 1-sentence instruction, e.g., 'Eat a grilled chicken salad.')",
  "exp": "(Logical 1-sentence explanation of why this optimizes their parameters)",
  "confidence": (Integer between 70 and 95),
  "isLife": (true ONLY if this is a major emotional/life decision, false otherwise),
  "rejected": [
    { "text": "(A rejected alternative)", "reason": "(Why it was rejected based on constraints)" },
    { "text": "(A second rejected alternative)", "reason": "(Why it was rejected)" }
  ]
}
OUTPUT ONLY JSON.`;

    try {
        // Call SECURE Backend Proxy (Vercel API route)
        // This hides the Groq Key from the public.
        const response = await fetch("/api/decide", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ systemPrompt })
        });

        const data = await response.json();
        
        // Handle Rate limits or proxy errors passed down
        if (data.error && data.id) {
            return data; // Backend returned a structured fallback JSON error
        }

        if (!response.ok) throw new Error(data.error || "Backend Integration Failed");
        
        return data;

    } catch (err) {
        console.error("LLM Generation Failed:", err);
        return {
            id: `err_${Date.now()}`,
            category: targetCat,
            text: "Pause operations.",
            exp: "API neural link severed or rate limit engaged. Rest until bandwidth restores.",
            confidence: 50,
            isLife: false,
            rejected: [{text: "Continue working", reason: "Proxy Error prevented compilation."}]
        };
    }
}


/* =======================================
   4. UI CONTROLLER EXPORTS
======================================= */
function showScreen(screenId) {
    document.querySelectorAll('#app-container > div:not(#main-header)').forEach(el => el.classList.add('hidden'));
    document.getElementById(screenId).classList.remove('hidden');
    
    if (screenId === 'screen-splash' || screenId === 'screen-decision-overlay') {
        document.getElementById('main-header').classList.add('hidden');
    } else {
        document.getElementById('main-header').classList.remove('hidden');
    }
}

window.startOnboarding = () => showScreen('screen-onboard');

window.completeOnboarding = () => {
    appState.prefs.goal = document.getElementById('ob-goal').value;
    appState.prefs.diet = document.getElementById('ob-diet').value;
    appState.prefs.budget = document.getElementById('ob-budget').value;
    appState.onboarded = true;
    saveState();
    showScreen('screen-dashboard');
    gatherContext();
};

window.setCategory = (cat, btnElement) => {
    activeCategory = cat;
    document.querySelectorAll('.category-pill').forEach(el => el.classList.remove('active'));
    btnElement.classList.add('active');
};

function checkExtremeLock() {
    const trustPercent = appState.stats.total === 0 ? 0 : Math.round((appState.stats.accepted / appState.stats.total) * 100);
    const msInDay = 1000 * 60 * 60 * 24;
    const daysSinceFirstUse = (Date.now() - appState.firstUsed) / msInDay;
    
    return (appState.stats.accepted >= 10 && trustPercent >= 70 && daysSinceFirstUse >= 2);
}

function updateDashboardUI() {
    const trustPercent = appState.stats.total === 0 ? 0 : Math.round((appState.stats.accepted / appState.stats.total) * 100);
    document.getElementById('stat-trust').innerHTML = `${trustPercent}% <span style="font-size:10px; display:block; color:var(--text-muted)">Trust Rating</span>`;
    document.getElementById('stat-streak').innerHTML = `${appState.stats.streak} <span style="font-size:10px; display:block; color:var(--text-muted)">Consecutive Obeys</span>`;
    document.getElementById('stat-time-saved').innerText = `${appState.stats.timeSavedMins} mins`;

    const canUnlockExtreme = checkExtremeLock();
    const extremeRadio = document.getElementById('radio-extreme');
    const extremeLock = document.getElementById('extreme-lock');
    
    if (canUnlockExtreme) {
        extremeRadio.disabled = false;
        extremeLock.classList.add('hidden');
        document.getElementById('setting-extreme').classList.remove('locked-setting');
    } else {
        extremeRadio.disabled = true;
        extremeLock.classList.remove('hidden');
        document.getElementById('setting-extreme').classList.add('locked-setting');
        if (appState.mode === 'extreme') {
            appState.mode = 'standard';
            document.querySelector('input[name="mode"][value="standard"]').checked = true;
        }
    }

    const statusEl = document.getElementById('extreme-status');
    if (appState.mode === 'extreme') {
        statusEl.innerHTML = `<span class="extreme-badge"><i class='bx bx-meteor'></i> EXTREME MODE ACTIVE</span>`;
    } else {
        statusEl.innerHTML = "";
    }

    document.querySelectorAll('input[name="mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            appState.mode = e.target.value;
            saveState();
        });
    });

    const histContainer = document.getElementById('history-container');
    if (appState.history.length === 0) {
        histContainer.innerHTML = `
            <div class="history-item">
                <i class='bx bx-minus history-icon'></i>
                <div class="history-content"><div class="history-title" style="color: var(--text-muted)">No tactical logs.</div></div>
            </div>`;
    } else {
        histContainer.innerHTML = '';
        appState.history.slice(0, 5).forEach(item => {
            const icon = item.status === 'accepted' ? 'bx-check-circle' : 'bx-x-circle';
            const colorClass = item.status === 'accepted' ? 'accepted' : 'rejected';
            histContainer.innerHTML += `
                <div class="history-item">
                    <i class='bx ${icon} history-icon ${colorClass}'></i>
                    <div class="history-content">
                        <div class="history-title">${item.cmd}</div>
                        <div class="history-meta">${item.cat.toUpperCase()} • ${new Date(item.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
                    </div>
                </div>`;
        });
    }
}

window.resetMemory = () => {
    if(confirm("Wipe all neural history and trust scores? This cannot be undone.")) {
        appState.stats = { total: 0, accepted: 0, streak: 0, timeSavedMins: 0 };
        appState.history = [];
        appState.firstUsed = Date.now();
        document.querySelector('input[name="mode"][value="standard"]').checked = true;
        appState.mode = 'standard';
        saveState();
        showScreen('screen-dashboard');
    }
};

window.retrainPreferences = () => showScreen('screen-onboard');

/* =======================================
   5. OVERLAY DECISION FLOW & VOICE
======================================= */
const loadingTexts = [
    "Analyzing neural patterns...", 
    "Accessing live OpenWeather matrix...", 
    "Compiling constraint heuristics via Groq LLM...",
    "Overriding human hesitation..."
];

window.executeDecision = async () => {
    showScreen('screen-decision-overlay');
    document.getElementById('dec-loader').classList.remove('hidden');
    document.getElementById('dec-result').classList.add('hidden');
    
    let loadStep = 0;
    const textEl = document.getElementById('loading-txt');
    textEl.innerText = loadingTexts[0];

    const cycleInterval = setInterval(() => {
        loadStep++;
        if(loadStep < loadingTexts.length) textEl.innerText = loadingTexts[loadStep];
    }, 800);

    // AI Generation Call
    currentDecision = await requestLLMDecision(activeCategory);
    
    clearInterval(cycleInterval);
    finalizeDecision(); // Render the exact generated UI
}

function finalizeDecision() {
    document.getElementById('dec-loader').classList.add('hidden');
    document.getElementById('dec-result').classList.remove('hidden');

    document.getElementById('res-cat').innerText = `TARGET VECTOR: ${currentDecision.category}`;
    document.getElementById('res-cmd').innerText = currentDecision.text;
    
    const isExtreme = appState.mode === 'extreme';
    document.getElementById('res-exp').innerText = isExtreme ? "[EXPLANATION OMITTED. EXECUTE DIRECTIVE.]" : currentDecision.exp;

    // Explainability Log
    const reqContainer = document.getElementById('res-rejected-list');
    if (!isExtreme && currentDecision.rejected && currentDecision.rejected.length > 0) {
        document.getElementById('panel-rejected').classList.remove('hidden');
        reqContainer.innerHTML = '';
        currentDecision.rejected.forEach(rej => {
            reqContainer.innerHTML += `
            <div class="rejected-item">
                <span class="rejected-action">${rej.text}</span>
                <span class="rejected-reason">${rej.reason}</span>
            </div>`;
        });
    } else {
        document.getElementById('panel-rejected').classList.add('hidden');
    }

    document.getElementById('res-conf').innerText = `${currentDecision.confidence}%`;
    setTimeout(() => {
        document.getElementById('res-conf-fill').style.width = `${currentDecision.confidence}%`;
    }, 100);

    const disclaimer = document.getElementById('res-disclaimer');
    if (currentDecision.isLife) disclaimer.classList.remove('hidden');
    else disclaimer.classList.add('hidden');

    // Show/Hide Voice Auth check
    const voiceBtn = document.getElementById('btn-voice');
    if('speechSynthesis' in window) voiceBtn.classList.remove('hidden');
    else voiceBtn.classList.add('hidden');
}

window.handleDecisionResponse = (action) => {
    appState.stats.total += 1;
    
    if (action === 'accept') {
        appState.stats.accepted += 1;
        appState.stats.streak += 1;
        let timeSaved = 5;
        if(currentDecision.category === 'food') timeSaved = 3;
        if(currentDecision.category === 'life') timeSaved = 15;
        appState.stats.timeSavedMins += timeSaved;
    } else {
        appState.stats.streak = 0;
    }

    appState.history.unshift({
        id: currentDecision.id,
        cat: currentDecision.category,
        cmd: currentDecision.text,
        status: action,
        ts: Date.now()
    });

    document.getElementById('res-conf-fill').style.width = '0%';
    window.speechSynthesis.cancel();
    
    saveState();
    showScreen('screen-dashboard');
}

window.speakDecision = () => {
    if (!('speechSynthesis' in window) || !currentDecision) return;
    
    const msg = new SpeechSynthesisUtterance();
    msg.text = `Execute directive. ${currentDecision.text}. ${currentDecision.exp}`;
    msg.rate = 1.0; 
    msg.pitch = 0.8;
    
    const voices = window.speechSynthesis.getVoices();
    const prefVoice = voices.find(v => v.lang.includes('en-') && !v.name.includes('Google'));
    if(prefVoice) msg.voice = prefVoice;

    window.speechSynthesis.speak(msg);
}

// Global functions accessible to HTML buttons
window.showScreen = showScreen;

/* =======================================
   6. BOOT
======================================= */
loadState();
if (appState.onboarded) {
    showScreen('screen-dashboard');
    gatherContext();
} else {
    showScreen('screen-splash');
}
