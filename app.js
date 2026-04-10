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

const WEATHER_API_KEY = "PLACEHOLDER_KEY"; // User will supply this in prod

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
                contextData.location = "Local Sector";
                document.getElementById('ctx-loc').innerHTML = `<i class='bx bx-map-pin'></i> ${contextData.location}`;
                
                try {
                    // Attempt real weather fetch
                    const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_API_KEY}&units=metric`);
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
   3. DECISION ENGINE & KNOWLEDGE
======================================= */
const DATABASE = {
    food: [
        { id: 'f1', text: "Eat grilled chicken salad.", exp: "High protein. Matches fitness parameters.", cost: 'med', diet: 'none', goal_align: 'health' },
        { id: 'f2', text: "Order a grain bowl.", exp: "Balanced macros for sustained cognitive function.", cost: 'high', diet: 'vegetarian', goal_align: 'productivity' },
        { id: 'f3', text: "Consume meal replacement shake.", exp: "Zero prep time. Maximum efficiency.", cost: 'low', diet: 'vegan', goal_align: 'productivity' },
        { id: 'f4', text: "Steak and eggs.", exp: "Dense nutrients. Optimal for keto profile.", cost: 'high', diet: 'keto', goal_align: 'health' },
        { id: 'f5', text: "Eat oatmeal with fruit.", exp: "Cost-effective morning energy vector.", cost: 'low', diet: 'vegan', goal_align: 'wealth' },
    ],
    clothing: [
        { id: 'c1', text: "Wear a dark technical hoodie.", exp: "Cloudy weather detected. Optimizes comfort and mobility.", weather_req: ['Clouds', 'Rain', 'Snow'], goal_align: 'productivity' },
        { id: 'c2', text: "Wear monochrome athleisure.", exp: "Aligns with fitness goals without sacrificing appearance.", weather_req: 'any', goal_align: 'health' },
        { id: 'c3', text: "Wear a structured blazer.", exp: "Projects authority. Required for wealth acquisition parameters.", weather_req: 'any', goal_align: 'wealth' },
        { id: 'c4', text: "Wear basic t-shirt and jeans.", exp: "Minimizes decision fatigue. Standard human uniform.", weather_req: 'any', goal_align: 'balance' }
    ],
    schedule: [
        { id: 's1', text: "Execute 90-minute focus block.", exp: "Time block optimal for deep work tasks.", time_req: ['morning', 'day'], goal_align: 'productivity' },
        { id: 's2', text: "Initiate gym sequence.", exp: "Biological maintenance required.", time_req: ['morning', 'evening'], goal_align: 'health' },
        { id: 's3', text: "Disconnect from devices.", exp: "Mandatory system cooldown for cognitive longevity.", time_req: ['night', 'evening'], goal_align: 'balance' },
        { id: 's4', text: "Review financial vectors.", exp: "Audit accounts to ensure trajectory aligns with goals.", time_req: ['evening', 'day'], goal_align: 'wealth' }
    ],
    life: [
        { id: 'l1', text: "Terminate toxic engagement.", exp: "Current social vector is draining resources. Cut losses.", goal_align: 'all' },
        { id: 'l2', text: "Request a salary adjustment.", exp: "Metrics indicate you are undervalued. Initiate protocol.", goal_align: 'wealth' },
        { id: 'l3', text: "Acquire new technical skill.", exp: "Adaptation is required for market survival.", goal_align: 'productivity' },
        { id: 'l4', text: "Book an isolated vacation.", exp: "Stress levels critical. Retreat recommended.", goal_align: 'balance' }
    ]
};

// Determines 'Auto-Detect' category dynamically based on past acceptance
function getDynamicCategory() {
    if (appState.history.length < 5) {
        // Fallback to time-based defaults if not enough history
        const t = contextData.timeBlock;
        if (t === 'morning') return Math.random() > 0.5 ? 'schedule' : 'clothing';
        if (t === 'day') return Math.random() > 0.5 ? 'schedule' : 'food';
        return Math.random() > 0.7 ? 'life' : 'food';
    }

    // Tally accepted categories
    let counts = { food: 0, clothing: 0, schedule: 0, life: 0 };
    appState.history.forEach(item => {
        if (item.status === 'accepted') counts[item.cat]++;
    });

    // Bias selection heavily towards mostly-accepted categories, mixing with time
    const sortedCats = Object.keys(counts).sort((a,b) => counts[b] - counts[a]);
    return Math.random() > 0.3 ? sortedCats[0] : sortedCats[1]; // 70% favorite, 30% runner up
}

function engineDecide(category) {
    const targetCat = (category === 'all') ? getDynamicCategory() : category;
    const options = DATABASE[targetCat];
    
    let scoredOptions = [];
    let rejectedLog = [];

    // Weights
    const W_PREF = 0.4;
    const W_CTX = 0.3;
    const W_GOAL = 0.3;
    const MAX_POSSIBLE = W_PREF + W_CTX + W_GOAL;

    options.forEach(opt => {
        let score = 0;
        let isRejected = false;
        let rejectReason = "";

        // 1. HARD CONSTRAINTS
        if (targetCat === 'food') {
            if (appState.prefs.budget === 'low' && opt.cost === 'high') { isRejected = true; rejectReason = "Exceeded budget profile."; }
            if (!isRejected && appState.prefs.diet !== 'none' && opt.diet !== appState.prefs.diet && opt.diet !== 'vegan') { isRejected = true; rejectReason = "Violates dietary hard constraint."; }
            if(!isRejected) score += W_PREF;
        } else if (targetCat === 'clothing') {
            if (opt.weather_req !== 'any') {
                if (contextData.weather.valid && !opt.weather_req.includes(contextData.weather.condition)) { isRejected = true; rejectReason = "Incompatible with current external environment."; }
            }
            if(!isRejected) score += W_CTX;
        } else if (targetCat === 'schedule') {
            if (!opt.time_req.includes(contextData.timeBlock)) { isRejected = true; rejectReason = "Sub-optimal scheduling block."; }
            if(!isRejected) score += W_CTX;
        } else if (targetCat === 'life') {
            score += W_CTX; // Pass through
        }

        if (isRejected) {
            rejectedLog.push({ text: opt.text, reason: rejectReason });
            return; // Skip giving it a real score
        }

        // 2. SOFT SCORING
        if (opt.goal_align === appState.prefs.goal || opt.goal_align === 'all') score += W_GOAL;
        else score += (W_GOAL * 0.2); // Partial fit

        // 3. Stonger Diversity Penalty (Look at last 10)
        const recentIds = appState.history.slice(0, 10).map(h => h.id);
        if (recentIds.includes(opt.id)) score -= 0.3;

        // Base random tie-breaker
        score += (Math.random() * 0.1);

        let mathConf = Math.round((score / MAX_POSSIBLE) * 100);
        let confBounded = Math.min(mathConf, 95); // Cap realistic confidence at 95%

        scoredOptions.push({ ...opt, score, confidence: confBounded });
    });

    // Sort descending
    scoredOptions.sort((a, b) => b.score - a.score);

    if (scoredOptions.length === 0) {
        return {
            id: 'err1', category: targetCat, text: "Wait and reassess.", exp: "Current parameters yielded no optimal vectors.", confidence: 50, isLife: false, rejected: rejectedLog
        };
    }

    // Compile Rejected list from actual rejected items + lower scored items
    for(let i=1; i < scoredOptions.length; i++) {
        rejectedLog.push({ text: scoredOptions[i].text, reason: `Suboptimal coefficient overlap (${scoredOptions[i].confidence}%).` });
    }

    // Exploration vs Exploitation (10% pick runner-up to prevent stagnation)
    let finalSelection = scoredOptions[0];
    if (scoredOptions.length > 1 && Math.random() < 0.1) {
        finalSelection = scoredOptions[1];
        // Move the #1 choice down to the rejected log so transparency tracks it
        rejectedLog.unshift({ text: scoredOptions[0].text, reason: "Engine overrode highest probability to prevent behavioral stagnation." });
    }

    return {
        id: finalSelection.id,
        category: targetCat,
        text: finalSelection.text,
        exp: finalSelection.exp,
        confidence: finalSelection.confidence,
        isLife: targetCat === 'life',
        rejected: rejectedLog.slice(0, 3) // Return top 3 rejected for explainability
    };
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
    
    // Extreme mode threshold: 10 obeys, 70% trust AND >= 2 days of usage
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

    // Apply Mode Listener
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
    "Accessing context matrix...", 
    "Compile constraint heuristics...",
    "Overriding human hesitation..."
];

window.executeDecision = () => {
    showScreen('screen-decision-overlay');
    document.getElementById('dec-loader').classList.remove('hidden');
    document.getElementById('dec-result').classList.add('hidden');
    
    let loadStep = 0;
    const textEl = document.getElementById('loading-txt');
    textEl.innerText = loadingTexts[0];

    const interval = setInterval(() => {
        loadStep++;
        if(loadStep < loadingTexts.length) {
            textEl.innerText = loadingTexts[loadStep];
        } else {
            clearInterval(interval);
            finalizeDecision();
        }
    }, 600);
}

function finalizeDecision() {
    currentDecision = engineDecide(activeCategory);
    
    document.getElementById('dec-loader').classList.add('hidden');
    document.getElementById('dec-result').classList.remove('hidden');

    document.getElementById('res-cat').innerText = `TARGET VECTOR: ${currentDecision.category}`;
    document.getElementById('res-cmd').innerText = currentDecision.text;
    
    const isExtreme = appState.mode === 'extreme';
    document.getElementById('res-exp').innerText = isExtreme ? "[EXPLANATION OMITTED. EXECUTE DIRECTIVE.]" : currentDecision.exp;

    // Explainability Log
    const reqContainer = document.getElementById('res-rejected-list');
    if (!isExtreme && currentDecision.rejected.length > 0) {
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
    window.speechSynthesis.cancel(); // Stop speaking if they click away
    
    saveState();
    showScreen('screen-dashboard');
}

window.speakDecision = () => {
    if (!('speechSynthesis' in window) || !currentDecision) return;
    
    const msg = new SpeechSynthesisUtterance();
    msg.text = `Execute directive. ${currentDecision.text}. ${currentDecision.exp}`;
    msg.rate = 1.0; 
    msg.pitch = 0.8; // Lower pitch to sound more authoritative
    
    // Select an English voice if available, preferably a system default that sounds clean
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
