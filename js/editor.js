/**
 * Eye on the Sky — editor.js
 * Lógica completa del editor para el estudiante:
 *   - Gestión de carpeta del proyecto (File System Access API)
 *   - Autoguardado cada 30 segundos
 *   - Telemetría: keystrokes, eventos de pegado, sesiones
 *   - Gestión de fuentes bibliográficas
 *   - Inserción de capturas PDF (imágenes locales)
 *   - Generación de citas Chicago / APA
 *   - Exportación: PDF (print), DOCX, RIS para Zotero
 *   - Firma SHA-256 del JSON para detectar manipulación
 */

'use strict';

/* ================================================================
   ESTADO GLOBAL DE LA APLICACIÓN
   ================================================================ */

const App = {
  // Handles del sistema de archivos
  dirHandle:      null,   // FileSystemDirectoryHandle del proyecto
  capturasHandle: null,   // FileSystemDirectoryHandle de subcarpeta capturas/
  jsonFileHandle: null,   // FileSystemFileHandle del documento.json

  // Datos del proyecto (lo que se serializa a JSON)
  project: {
    metadata: {
      title:         '',
      course:        'Seminario de Grado',
      student_name:  '',
      created_at:    new Date().toISOString(),
      last_saved:    null,
      app_version:   '1.0.0',
      schema_version: 1,
    },
    content: {
      delta: null,   // Quill Delta (fuente de verdad)
      html:  '',
    },
    sources:   [],  // Array de objetos fuente bibliográfica
    telemetry: {
      sessions: [],
      summary: {
        total_sessions:       0,
        total_days_active:    0,
        total_words_typed:    0,
        total_chars_pasted:   0,
        manual_ratio:         0,
        sources_with_screenshot: 0,
        sources_cited_in_text:   0,
      }
    },
    biometrics: {
      baseline: null,
      session_metrics: {
        samples: 0,
        mean_dwell_ms: 0,
        mean_flight_ms: 0,
        similarity_score: 100,
      }
    }
  },

  // Estado de la sesión actual
  session: {
    id:                null,   // 'ses_...'
    session_number:    1,
    start_time:        null,
    words_typed:       0,
    chars_pasted:      0,
    paste_events:      [],
    keystroke_count:   0,
    initial_word_count: 0,
    active_days_set:   new Set(),
    timer_ref:         null,
    autosave_ref:      null,
    previousWordCount: 0,  // para calcular diff de palabras real
    isPasting:         false, // flag para text-change: ignorar palabras de paste
    passedMilestones:  new Set(),
    biometrics: {
      activeKeyDowns: new Map(),
      lastKeyUpTime:  0,
      samples:        [],
      spaceDwells:    [],
      backspaceDwells: [],
      notifiedBaseline: false,
    }
  },

  // Flags de UI
  ui: {
    sourcesPanelOpen: true,
    telePanelOpen:    true,
    isDirty:          false,  // hay cambios sin guardar
    currentTheme:     'light',
    projectLoaded:    false,
    editingSourceId:  null,   // null = nueva fuente, string = editar existente
    pendingScreenshot: null,  // { file, previewUrl }
  },

  // Instancia de Quill
  quill: null,
};

/* ================================================================
   MOTOR DE SONIDOS Y GAMIFICACIÓN (SoundFx)
   ================================================================ */

const SoundFx = {
  enabled: localStorage.getItem('eots-sound-enabled') !== 'false',
  files: {
    session_start:   'Sounds/session_start.mp3',
    milestone_words: 'Sounds/milestone_words.mp3',
    source_captured: 'Sounds/citation_success.mp3',
    autosave_peace:  'Sounds/calibration_complete.mp3',
    paste_alert:     'Sounds/paste_warning.mp3',
    export_success:  'Sounds/calibration_complete.mp3',
  },
  audioCache: {},

  init() {
    for (const [key, path] of Object.entries(this.files)) {
      try {
        const audio = new Audio();
        audio.src = path;
        audio.preload = 'none'; // No forzar precarga en conexiones móviles
        this.audioCache[key] = audio;
      } catch (err) {
        console.debug('No se pudo inicializar audio:', key, err);
      }
    }
    this.updateUI();
  },

  play(name) {
    if (!this.enabled || !this.files[name]) return;
    try {
      const base = this.audioCache[name];
      if (!base) return;
      const sound = base.cloneNode();
      sound.volume = 0.45;
      const promise = sound.play();
      if (promise !== undefined) {
        promise.catch(() => {
          // Silenciar advertencia de política de autoplay en móviles
        });
      }
    } catch (e) {
      // Ignorar bloqueos de audio móvil
    }
  },

  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('eots-sound-enabled', String(this.enabled));
    this.updateUI();
    if (this.enabled) {
      this.play('autosave_peace');
      showToast('Efectos de sonido activados.', 'info');
    } else {
      showToast('Efectos de sonido silenciados.', 'info');
    }
  },

  updateUI() {
    const btn = document.getElementById('btn-sound-toggle');
    const iconOn = document.getElementById('sound-icon-on');
    const iconOff = document.getElementById('sound-icon-off');
    if (btn) btn.title = this.enabled ? 'Efectos de sonido (Activados)' : 'Efectos de sonido (Silenciados)';
    if (iconOn) iconOn.classList.toggle('hidden', !this.enabled);
    if (iconOff) iconOff.classList.toggle('hidden', this.enabled);
  }
};

/* ================================================================
   MOTOR DE BIOMETRÍA DE ESCRITURA Y DINÁMICA DE TECLEO
   ================================================================ */

const BiometricsEngine = {
  REQUIRED_SAMPLES: 250,

  onKeyDown(e) {
    if (['Shift','Control','Alt','Meta','CapsLock'].includes(e.key)) return;
    const now = performance.now();
    const keyId = e.code || e.key;
    if (!App.session.biometrics.activeKeyDowns.has(keyId)) {
      App.session.biometrics.activeKeyDowns.set(keyId, { time: now, key: e.key });
    }
  },

  onKeyUp(e) {
    if (['Shift','Control','Alt','Meta','CapsLock'].includes(e.key)) return;
    const now = performance.now();
    const keyId = e.code || e.key;
    const downRec = App.session.biometrics.activeKeyDowns.get(keyId);
    if (!downRec) return;
    App.session.biometrics.activeKeyDowns.delete(keyId);

    const dwell = now - downRec.time; // Hold time en ms
    if (dwell < 15 || dwell > 900) return; // filtrar rebotes anómalos o teclas atascadas

    let flight = null;
    if (App.session.biometrics.lastKeyUpTime > 0) {
      flight = downRec.time - App.session.biometrics.lastKeyUpTime;
    }
    App.session.biometrics.lastKeyUpTime = now;

    // Solo considerar pausas de ritmo de tipeo normales (10ms a 2500ms)
    const validFlight = (flight !== null && flight >= 10 && flight <= 2500) ? flight : null;

    App.session.biometrics.samples.push({
      dwell,
      flight: validFlight,
      key: e.key,
      time: Date.now()
    });

    if (e.key === ' ') App.session.biometrics.spaceDwells.push(dwell);
    if (e.key === 'Backspace') App.session.biometrics.backspaceDwells.push(dwell);

    this.process();
  },

  process() {
    const samples = App.session.biometrics.samples;
    const count = samples.length;
    const baseline = App.project.biometrics?.baseline;

    if (!baseline) {
      // Fase de calibración
      const dwellValues = samples.map(s => s.dwell);
      const flightValues = samples.filter(s => s.flight !== null).map(s => s.flight);

      const meanD = dwellValues.length ? (dwellValues.reduce((a, b) => a + b, 0) / dwellValues.length) : 0;
      const meanF = flightValues.length ? (flightValues.reduce((a, b) => a + b, 0) / flightValues.length) : 0;

      const statusEl = document.getElementById('tele-bio-status');
      const dwellEl  = document.getElementById('tele-bio-dwell');
      const flightEl = document.getElementById('tele-bio-flight');
      const simEl    = document.getElementById('tele-bio-similarity');

      if (statusEl) statusEl.textContent = `Calibrando (${count}/${this.REQUIRED_SAMPLES})`;
      if (dwellEl)  dwellEl.textContent  = meanD ? `${Math.round(meanD)} ms` : '—';
      if (flightEl) flightEl.textContent = meanF ? `${Math.round(meanF)} ms` : '—';
      if (simEl)    simEl.textContent    = 'En curso';

      // ¿Se alcanzó la muestra requerida?
      if (count >= this.REQUIRED_SAMPLES && !App.session.biometrics.notifiedBaseline) {
        this.calibrateBaseline(samples, dwellValues, flightValues);
      }
    } else {
      // Huella establecida: verificación continua de identidad
      this.verifySession(samples, baseline);
    }
  },

  calibrateBaseline(samples, dwellValues, flightValues) {
    App.session.biometrics.notifiedBaseline = true;

    const meanD = dwellValues.reduce((a, b) => a + b, 0) / dwellValues.length;
    const varianceD = dwellValues.reduce((sum, v) => sum + Math.pow(v - meanD, 2), 0) / dwellValues.length;
    const stdD = Math.sqrt(varianceD);

    const meanF = flightValues.length ? (flightValues.reduce((a, b) => a + b, 0) / flightValues.length) : 150;
    const varianceF = flightValues.length ? (flightValues.reduce((sum, v) => sum + Math.pow(v - meanF, 2), 0) / flightValues.length) : 400;
    const stdF = Math.sqrt(varianceF);

    const spaceMean = App.session.biometrics.spaceDwells.length
      ? App.session.biometrics.spaceDwells.reduce((a,b)=>a+b,0) / App.session.biometrics.spaceDwells.length
      : meanD;

    const backspaceMean = App.session.biometrics.backspaceDwells.length
      ? App.session.biometrics.backspaceDwells.reduce((a,b)=>a+b,0) / App.session.biometrics.backspaceDwells.length
      : meanD;

    App.project.biometrics.baseline = {
      established_at:     new Date().toISOString(),
      sample_size:        samples.length,
      mean_dwell_ms:      Math.round(meanD * 10) / 10,
      std_dwell_ms:       Math.round(stdD * 10) / 10,
      mean_flight_ms:     Math.round(meanF * 10) / 10,
      std_flight_ms:      Math.round(stdF * 10) / 10,
      space_dwell_ms:     Math.round(spaceMean * 10) / 10,
      backspace_dwell_ms: Math.round(backspaceMean * 10) / 10,
    };

    App.project.biometrics.session_metrics = {
      samples: samples.length,
      mean_dwell_ms: Math.round(meanD * 10) / 10,
      mean_flight_ms: Math.round(meanF * 10) / 10,
      similarity_score: 100
    };

    // Actualizar campos del modal
    const mDwell = document.getElementById('modal-bio-dwell');
    const mFlight = document.getElementById('modal-bio-flight');
    const mSamples = document.getElementById('modal-bio-samples');
    if (mDwell)   mDwell.textContent   = `${Math.round(meanD)} ms`;
    if (mFlight)  mFlight.textContent  = `${Math.round(meanF)} ms`;
    if (mSamples) mSamples.textContent = `${samples.length} pulsaciones`;

    // Abrir modal notificando al usuario
    openModal('modal-biometrics-overlay');

    // Reproducir sonido de hito
    SoundFx.play('milestone_words');

    this.updateUI();

    // Guardar para asentar la huella en el JSON inmediatamente
    saveProject();
  },

  verifySession(samples, baseline) {
    if (samples.length < 25) return;

    const dwellValues = samples.map(s => s.dwell);
    const flightValues = samples.filter(s => s.flight !== null).map(s => s.flight);

    const sessMeanD = dwellValues.reduce((a, b) => a + b, 0) / dwellValues.length;
    const sessMeanF = flightValues.length ? (flightValues.reduce((a, b) => a + b, 0) / flightValues.length) : baseline.mean_flight_ms;

    // Distancia normalizada
    const zD = Math.abs(sessMeanD - baseline.mean_dwell_ms) / Math.max(baseline.std_dwell_ms || 20, 10);
    const zF = Math.abs(sessMeanF - baseline.mean_flight_ms) / Math.max(baseline.std_flight_ms || 35, 15);
    const dist = 0.5 * zD + 0.5 * zF;

    const similarity = Math.max(0, Math.min(100, Math.round(100 - (dist * 20))));

    App.project.biometrics.session_metrics = {
      samples: samples.length,
      mean_dwell_ms: Math.round(sessMeanD * 10) / 10,
      mean_flight_ms: Math.round(sessMeanF * 10) / 10,
      similarity_score: similarity
    };

    this.updateUI();
  },

  updateUI() {
    const baseline = App.project.biometrics?.baseline;
    const statusEl = document.getElementById('tele-bio-status');
    const dwellEl  = document.getElementById('tele-bio-dwell');
    const flightEl = document.getElementById('tele-bio-flight');
    const simEl    = document.getElementById('tele-bio-similarity');

    if (baseline) {
      if (statusEl) {
        statusEl.textContent = '✓ Calibrada';
        statusEl.style.color = 'var(--success)';
      }
      const sm = App.project.biometrics.session_metrics;
      if (dwellEl)  dwellEl.textContent  = `${sm?.mean_dwell_ms || baseline.mean_dwell_ms} ms`;
      if (flightEl) flightEl.textContent = `${sm?.mean_flight_ms || baseline.mean_flight_ms} ms`;
      if (simEl) {
        const score = sm?.similarity_score ?? 100;
        simEl.textContent = `${score}%`;
        if (score >= 75) {
          simEl.style.color = 'var(--success)';
        } else if (score >= 60) {
          simEl.style.color = 'var(--warning)';
        } else {
          simEl.style.color = 'var(--danger)';
        }
      }
    } else {
      if (statusEl) {
        const cnt = App.session.biometrics.samples.length;
        statusEl.textContent = `Calibrando (${cnt}/${this.REQUIRED_SAMPLES})`;
        statusEl.style.color = 'var(--accent)';
      }
    }
  }
};

/* ================================================================
   INICIALIZACIÓN
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  SoundFx.init();
  initQuill();
  initEventListeners();
  initSessionTimer();
  restoreTheme();
  checkAndRestoreActiveProject();
});

function checkAndRestoreActiveProject() {
  const saved = localStorage.getItem('eots_active_project');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed && (parsed.content || parsed.metadata)) {
        const name = localStorage.getItem('eots_active_project_name') || 'documento.json';
        loadProjectFromParsedJSON(parsed, name);
      }
    } catch (e) {
      console.debug('No se pudo restaurar sesión activa de localStorage:', e);
    }
  }
}

function initQuill() {
  App.quill = new Quill('#quill-editor', {
    theme: 'snow',
    modules: {
      toolbar: '#quill-toolbar',
    },
    placeholder: 'Comienza a escribir tu documento de investigación aquí…',
  });

  // Telemetría: detectar texto tecleado vs pegado
  App.quill.on('text-change', (delta, oldDelta, source) => {
    if (source !== 'user') return;
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');

    const text       = App.quill.getText();
    const currentWC  = countWords(text);
    const wordDiff   = Math.max(0, currentWC - App.session.previousWordCount);

    // Solo sumar al conteo manual si NO fue un pegado
    if (!App.session.isPasting && wordDiff > 0) {
      App.session.words_typed += wordDiff;
    }

    // Hitos de palabras para gamificación (100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000)
    const milestones = [100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 5000];
    for (const m of milestones) {
      if (currentWC >= m && !App.session.passedMilestones.has(m)) {
        App.session.passedMilestones.add(m);
        if (!App.session.isPasting) {
          SoundFx.play('milestone_words');
          showToast(`🎯 ¡Hito alcanzado: ${m} palabras escritas!`, 'success');
        }
      }
    }

    App.session.previousWordCount = currentWC;
    updateWordCount(currentWC);
    updateTelemetryUI();
  });

  // Activar corrector ortográfico nativo del navegador en español y eventos biométricos
  const editorEl = document.querySelector('#quill-editor .ql-editor');
  if (editorEl) {
    editorEl.setAttribute('spellcheck', 'true');
    editorEl.setAttribute('lang', 'es');
    editorEl.setAttribute('autocorrect', 'on');
    editorEl.addEventListener('paste', handlePasteEvent);
    editorEl.addEventListener('keydown', handleKeystrokeEvent);
    editorEl.addEventListener('keyup', handleKeyUpEvent);
  }
}

/* ================================================================
   TELEMETRÍA
   ================================================================ */

function handlePasteEvent(e) {
  const clipText = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  const chars = clipText.length;
  if (chars < 10) return; // ignora pegados triviales

  // ¿El documento estaba vacío antes del pegado?
  const isInitialPaste = App.session.previousWordCount === 0;
  const range = App.quill ? App.quill.getSelection(true) : null;
  const pasteIndex = range ? range.index : 0;

  // Activar flag para que text-change no cuente estas palabras como manuales
  App.session.isPasting = true;
  setTimeout(() => {
    App.session.isPasting = false;
    // Aplicar color de procedencia en Quill según el tipo de pegado
    if (App.quill && chars > 0) {
      const bgColor = isInitialPaste ? 'rgba(74, 108, 247, 0.16)' : 'rgba(229, 57, 53, 0.18)';
      App.quill.formatText(pasteIndex, chars, 'background', bgColor);
    }
  }, 80);

  const pasteRecord = {
    timestamp:    new Date().toISOString(),
    chars_pasted: chars,
    approx_words: Math.round(chars / 5),
    is_initial:   isInitialPaste,
  };

  App.session.paste_events.push(pasteRecord);

  if (!isInitialPaste) {
    // Solo penalizar pastes que no son el inicial
    App.session.chars_pasted += chars;
    SoundFx.play('paste_alert');
  } else {
    showToast('Pegado inicial registrado sin penalización.', 'success');
  }

  updateTelemetryUI();
}

function handleKeystrokeEvent(e) {
  // Solo registrar para telemetría (el conteo de palabras ya lo hace text-change)
  const ignore = ['Control','Alt','Shift','Meta','CapsLock','Tab','Escape',
    'ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown',
    'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'];
  if (!ignore.includes(e.key)) {
    App.session.keystroke_count++;
  }
  // Procesar dinámica de pulsación para huella biométrica
  BiometricsEngine.onKeyDown(e);
}

function handleKeyUpEvent(e) {
  // Medir permanencia y pausas entre teclas para la huella biométrica
  BiometricsEngine.onKeyUp(e);
}

function initSessionTimer() {
  App.session.start_time = new Date();
  App.session.timer_ref = setInterval(() => {
    if (!App.session.start_time) return;
    const elapsed = Math.floor((Date.now() - App.session.start_time.getTime()) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    const teleTimerEl = document.getElementById('tele-session-time');
    const sbTimerEl   = document.getElementById('sb-session-time');
    if (teleTimerEl) teleTimerEl.textContent = `${mm}:${ss}`;
    if (sbTimerEl)   sbTimerEl.textContent   = `Sesión: ${mm}:${ss}`;
  }, 1000);
}

function updateTelemetryUI() {
  const typed = App.session.words_typed;

  // Solo contar pastes NO iniciales para el ratio de la sesión actual
  const penalizedPasteWords = App.session.paste_events
    .filter(ev => !ev.is_initial)
    .reduce((sum, ev) => sum + (ev.approx_words || 0), 0);

  const total = typed + penalizedPasteWords;
  // Si no hay actividad aún, ratio = 100% (no mostrar 0)
  const ratio = total > 0 ? Math.round((typed / total) * 100) : 100;

  const wordsTypedEl = document.getElementById('tele-words-typed');
  if (wordsTypedEl) wordsTypedEl.textContent = typed;
  const pasteCountEl = document.getElementById('tele-paste-count');
  if (pasteCountEl) pasteCountEl.textContent = App.session.paste_events.filter(ev => !ev.is_initial).length;

  // Barra de salud
  const fill = document.getElementById('health-fill');
  const pct  = document.getElementById('health-percent');
  if (fill && pct) {
    fill.style.width = `${ratio}%`;
    pct.textContent  = `${ratio}%`;
    fill.classList.remove('medium', 'low');
    if (ratio < 50) fill.classList.add('low');
    else if (ratio < 75) fill.classList.add('medium');
  }

  // Fuentes con captura
  const withImg    = (App.project.sources || []).filter(s => s.screenshot_filename).length;
  const totalSrcs  = (App.project.sources || []).length;
  const sourcesImgEl = document.getElementById('tele-sources-with-img');
  if (sourcesImgEl) sourcesImgEl.textContent = `${withImg}/${totalSrcs}`;

  // Totales acumulados históricos
  const totalSessionsCount = (App.project.telemetry?.sessions || []).length || 1;
  const totalSessionsEl = document.getElementById('tele-total-sessions');
  if (totalSessionsEl) totalSessionsEl.textContent = totalSessionsCount;

  const daysActiveEl = document.getElementById('tele-days-active');
  if (daysActiveEl) {
    const daysSet = new Set((App.project.telemetry?.sessions || []).map(s => s.date).filter(Boolean));
    if (App.session.start_time) {
      daysSet.add(App.session.start_time.toISOString().split('T')[0]);
    }
    daysActiveEl.textContent = daysSet.size || 1;
  }
}

/* ================================================================
   GESTIÓN DEL PROYECTO (File System Access API)
   ================================================================ */

async function openOrCreateProject(mode) {
  if (!('showDirectoryPicker' in window)) {
    showToast('Tu navegador no soporta la API de acceso a archivos. Usa Chrome o Edge.', 'error');
    return;
  }

  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    App.dirHandle = dirHandle;

    // Crear o abrir subcarpeta capturas/
    App.capturasHandle = await dirHandle.getDirectoryHandle('capturas', { create: true });

    if (mode === 'new') {
      await createNewProject(dirHandle);
    } else {
      await loadExistingProject(dirHandle);
    }

    // Cerrar modal de onboarding
    closeModal('modal-onboarding-overlay');
    App.ui.projectLoaded = true;

    // Actualizar nombre del proyecto en statusbar
    document.getElementById('sb-project-name').textContent = dirHandle.name;
    document.getElementById('open-folder-label').textContent = 'Cambiar carpeta';

    // Iniciar autoguardado (cada 30 segundos)
    startAutosave();

  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Error al abrir carpeta:', err);
      showToast('No se pudo abrir la carpeta. ' + err.message, 'error');
    }
  }
}

function startProjectSession() {
  const currentText = App.quill ? App.quill.getText() : '';
  const currentWC = countWords(currentText);

  // Asegurar estructura de telemetría en el proyecto
  if (!App.project.telemetry) {
    App.project.telemetry = { sessions: [], summary: {} };
  }
  if (!Array.isArray(App.project.telemetry.sessions)) {
    App.project.telemetry.sessions = [];
  }

  const sessionNum = App.project.telemetry.sessions.length + 1;
  const now = new Date();

  App.session.id = 'ses_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  App.session.session_number = sessionNum;
  App.session.start_time = now;
  App.session.words_typed = 0;
  App.session.chars_pasted = 0;
  App.session.paste_events = [];
  App.session.keystroke_count = 0;
  App.session.initial_word_count = currentWC;
  App.session.previousWordCount = currentWC;
  App.session.passedMilestones = new Set();

  // Inicializar o reiniciar telemetría biométrica para la nueva sesión
  App.session.biometrics = {
    activeKeyDowns:   new Map(),
    lastKeyUpTime:    0,
    samples:          [],
    spaceDwells:      [],
    backspaceDwells:  [],
    notifiedBaseline: !!(App.project.biometrics && App.project.biometrics.baseline),
  };

  // Reconstruir conjunto de fechas activas
  App.session.active_days_set = new Set(
    App.project.telemetry.sessions.map(s => s.date).filter(Boolean)
  );
  App.session.active_days_set.add(now.toISOString().split('T')[0]);

  updateTelemetryUI();
  BiometricsEngine.updateUI();
}

async function createNewProject(dirHandle) {
  // Inicializar metadatos del proyecto
  App.project.metadata.created_at = new Date().toISOString();
  App.project.metadata.title = 'Sin título';
  document.getElementById('doc-title-input').value = '';

  startProjectSession();
  await saveProject();
  SoundFx.play('session_start');
  showToast('Proyecto creado. El autoguardado está activo.', 'success');
}

async function loadExistingProject(dirHandle) {
  try {
    let jsonHandle = null;
    let loadedFileName = 'documento.json';

    // 1. Intentar abrir documento.json estándar
    try {
      jsonHandle = await dirHandle.getFileHandle('documento.json');
    } catch (e) {
      // 2. Si no existe documento.json, buscar si hay algún archivo .json en la carpeta
      if ('values' in dirHandle) {
        for await (const entry of dirHandle.values()) {
          if (entry.kind === 'file' && entry.name.endsWith('.json')) {
            jsonHandle = entry;
            loadedFileName = entry.name;
            break;
          }
        }
      }
    }

    if (!jsonHandle) {
      // No hay ningún archivo .json en la carpeta → es una carpeta nueva
      await createNewProject(dirHandle);
      return;
    }

    const file   = await jsonHandle.getFile();
    const text   = await file.text();
    const parsed = JSON.parse(text);

    // Verificar firma de integridad
    const storedSig = parsed._signature;
    if (storedSig) {
      const valid = await verifySignature(parsed);
      if (!valid) {
        showToast('⚠ El archivo JSON fue modificado externamente. Los datos pueden no ser confiables.', 'warning');
      }
    }

    // Cargar datos
    App.project = { ...App.project, ...parsed };
    delete App.project._signature;

    // Asegurar estructura biométrica
    if (!App.project.biometrics) {
      App.project.biometrics = { baseline: null, session_metrics: null };
    }

    // Restaurar contenido en Quill
    if (App.project.content && App.project.content.delta) {
      App.quill.setContents(App.project.content.delta, 'silent');
    } else if (App.project.content && App.project.content.html) {
      App.quill.clipboard.dangerouslyPasteHTML(App.project.content.html);
    }

    // Restaurar título
    document.getElementById('doc-title-input').value = App.project.metadata.title || '';

    // Cargar fuentes en el panel
    renderSourcesList();

    // Contar palabras
    const currentWC = countWords(App.quill.getText());
    updateWordCount(currentWC);

    // Inicializar nueva sesión de trabajo con el punto de partida actual
    startProjectSession();

    // Guardar para registrar la apertura de la nueva sesión
    await saveProject();

    SoundFx.play('session_start');
    showToast(`Proyecto "${App.project.metadata.title || loadedFileName}" cargado.`, 'success');
    updateSaveStatus('saved');
    BiometricsEngine.updateUI();

  } catch (err) {
    console.error('Error al cargar proyecto de carpeta:', err);
    throw err;
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result || '');
      reader.onerror = (e) => {
        if (file && typeof file.text === 'function') {
          file.text().then(resolve).catch(reject);
        } else {
          reject(e);
        }
      };
      reader.readAsText(file);
    } catch (err) {
      if (file && typeof file.text === 'function') {
        file.text().then(resolve).catch(reject);
      } else {
        reject(err);
      }
    }
  });
}

async function loadProjectFromParsedJSON(parsed, sourceName = 'documento.json') {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('El archivo no contiene un formato JSON válido.');
  }

  // Verificar firma de integridad si existe
  const storedSig = parsed._signature;
  if (storedSig) {
    try {
      const valid = await verifySignature(parsed);
      if (!valid) {
        showToast('⚠ El archivo JSON fue modificado externamente. Firma alterada.', 'warning');
      }
    } catch (e) {
      console.debug('Error en validación de firma:', e);
    }
  }

  App.project = { ...App.project, ...parsed };
  delete App.project._signature;

  if (!App.project.metadata) {
    App.project.metadata = { title: (sourceName || 'documento').replace('.json', '') };
  }

  if (!App.project.biometrics) {
    App.project.biometrics = { baseline: null, session_metrics: null };
  }

  if (!Array.isArray(App.project.sources)) {
    App.project.sources = [];
  }

  // Restaurar contenido en Quill de forma segura
  if (App.quill) {
    try {
      if (App.project.content && App.project.content.delta) {
        App.quill.setContents(App.project.content.delta, 'silent');
      } else if (App.project.content && App.project.content.html) {
        App.quill.clipboard.dangerouslyPasteHTML(App.project.content.html);
      }
    } catch (quillErr) {
      console.warn('Error al cargar delta en Quill, usando HTML plano:', quillErr);
      if (App.project.content && App.project.content.html) {
        App.quill.clipboard.dangerouslyPasteHTML(App.project.content.html);
      }
    }
  }

  const titleInput = document.getElementById('doc-title-input');
  if (titleInput) titleInput.value = App.project.metadata.title || '';

  renderSourcesList();

  const currentWC = countWords(App.quill ? App.quill.getText() : '');
  updateWordCount(currentWC);
  startProjectSession();

  App.ui.projectLoaded = true;

  const sbName = document.getElementById('sb-project-name');
  if (sbName) sbName.textContent = sourceName;
  const folderLabel = document.getElementById('open-folder-label');
  if (folderLabel) folderLabel.textContent = sourceName.slice(0, 16) + '…';

  // Guardar en localStorage para que en móviles (Android / iOS) si se recarga la pestaña, se restaure sin modal
  try {
    localStorage.setItem('eots_active_project', JSON.stringify(parsed));
    localStorage.setItem('eots_active_project_name', sourceName);
  } catch (storageErr) {
    console.debug('No se pudo guardar respaldo en localStorage:', storageErr);
  }

  // Cerrar siempre el modal de bienvenida
  closeModal('modal-onboarding-overlay');

  try {
    SoundFx.play('session_start');
  } catch (e) {}

  showToast(`✓ Proyecto "${App.project.metadata.title || sourceName}" cargado exitosamente.`, 'success');
  updateSaveStatus('saved');
  if (BiometricsEngine.updateUI) BiometricsEngine.updateUI();
}

async function loadProjectFromJSONFile(file) {
  if (!file) return;
  showToast('Cargando documento...', 'info');

  try {
    const text = await readFileAsText(file);
    if (!text || !text.trim()) {
      throw new Error('El archivo seleccionado está vacío.');
    }
    const parsed = JSON.parse(text);
    await loadProjectFromParsedJSON(parsed, file.name || 'documento.json');
  } catch (err) {
    console.error('Error al cargar archivo JSON:', err);
    showToast('Error al abrir el JSON: ' + err.message, 'error');
  }
}

async function loadProjectFromJSONText(text, sourceName = 'documento_pegado.json') {
  if (!text || !text.trim()) {
    showToast('Por favor pega el contenido de tu archivo JSON en el recuadro.', 'warning');
    return;
  }
  try {
    const parsed = JSON.parse(text.trim());
    await loadProjectFromParsedJSON(parsed, sourceName);
  } catch (err) {
    console.error('Error al parsear texto JSON:', err);
    showToast('El texto pegado no es un JSON válido: ' + err.message, 'error');
  }
}

async function openJsonFileDialog() {
  const input = document.getElementById('onboard-file-input') || document.getElementById('input-load-json-direct');
  if (input) input.click();
}

/* ================================================================
   AUTOGUARDADO
   ================================================================ */

function startAutosave() {
  if (App.session.autosave_ref) clearInterval(App.session.autosave_ref);
  App.session.autosave_ref = setInterval(async () => {
    if (!App.ui.isDirty || !App.dirHandle) return;
    await saveProject();
  }, 30_000); // cada 30 segundos
}

async function saveProject() {
  updateSaveStatus('saving');

  try {
    // Capturar estado actual del editor
    if (App.quill) {
      App.project.content.delta = App.quill.getContents();
      App.project.content.html  = App.quill.root.innerHTML;
    }
    const titleInput = document.getElementById('doc-title-input');
    if (titleInput) {
      App.project.metadata.title = titleInput.value.trim() || App.project.metadata?.title || 'Sin título';
    }
    App.project.metadata.last_saved = new Date().toISOString();

    const currentWC = countWords(App.quill ? App.quill.getText() : '');
    const now = new Date();
    const startTime = App.session.start_time || now;
    const durationMin = Math.max(1, Math.round((now.getTime() - startTime.getTime()) / 60000));
    const todayISO = startTime.toISOString().split('T')[0];

    // Asegurar estructura
    if (!App.project.telemetry) App.project.telemetry = { sessions: [], summary: {} };
    if (!Array.isArray(App.project.telemetry.sessions)) App.project.telemetry.sessions = [];

    // Si aún no hay ID de sesión, generar uno
    if (!App.session.id) {
      App.session.id = 'ses_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      App.session.session_number = App.project.telemetry.sessions.length + 1;
    }

    // Registro detallado de la sesión activa
    const currentSessionRecord = {
      session_id:         App.session.id,
      session_number:     App.session.session_number,
      date:               todayISO,
      start_time:         startTime.toISOString(),
      end_time:           now.toISOString(),
      duration_minutes:   durationMin,
      initial_word_count: App.session.initial_word_count || 0,
      final_word_count:   currentWC,
      words_net_change:   currentWC - (App.session.initial_word_count || 0),
      words_typed:        App.session.words_typed,
      chars_pasted:       App.session.chars_pasted,
      paste_events:       [...App.session.paste_events],
      keystroke_count:    App.session.keystroke_count,
      biometrics: {
        samples:          App.session.biometrics?.samples?.length || 0,
        mean_dwell_ms:    App.project.biometrics?.session_metrics?.mean_dwell_ms || 0,
        mean_flight_ms:   App.project.biometrics?.session_metrics?.mean_flight_ms || 0,
        similarity_score: App.project.biometrics?.session_metrics?.similarity_score ?? (App.project.biometrics?.baseline ? 100 : null),
        is_consistent:    (App.project.biometrics?.session_metrics?.similarity_score ?? 100) >= 65,
      },
    };

    // Actualizar o agregar la sesión activa en el historial de sesiones
    const existingIndex = App.project.telemetry.sessions.findIndex(s => s.session_id === App.session.id);
    if (existingIndex >= 0) {
      App.project.telemetry.sessions[existingIndex] = currentSessionRecord;
    } else {
      App.project.telemetry.sessions.push(currentSessionRecord);
    }

    // Consolidar resumen de todas las sesiones
    const allSessions = App.project.telemetry.sessions;
    const daysSet = new Set(allSessions.map(s => s.date).filter(Boolean));
    const totalWordsTyped = allSessions.reduce((sum, s) => sum + (s.words_typed || 0), 0);
    const totalCharsPasted = allSessions.reduce((sum, s) => sum + (s.chars_pasted || 0), 0);

    let allPenalizedPasteWords = 0;
    allSessions.forEach(s => {
      (s.paste_events || []).forEach(ev => {
        if (!ev.is_initial) allPenalizedPasteWords += (ev.approx_words || 0);
      });
    });

    const totalCalculated = totalWordsTyped + allPenalizedPasteWords;
    const manualRatio = totalCalculated > 0 ? (totalWordsTyped / totalCalculated) : 1;

    App.project.telemetry.summary = {
      total_sessions:          allSessions.length,
      total_days_active:       daysSet.size,
      total_words_typed:       totalWordsTyped,
      total_chars_pasted:      totalCharsPasted,
      manual_ratio:            Math.round(manualRatio * 100) / 100,
      sources_with_screenshot: (App.project.sources || []).filter(s => s.screenshot_filename).length,
      sources_cited_in_text:   (App.project.sources || []).filter(s => s.cited_in_text).length,
    };

    // Crear objeto a serializar (sin imágenes base64 — solo rutas relativas)
    const payload = structuredClone(App.project);

    // Agregar firma de integridad
    payload._signature = await signPayload(payload);

    // Persistir siempre en localStorage (para móviles y sesiones sin carpeta)
    try {
      localStorage.setItem('eots_active_project', JSON.stringify(payload));
      localStorage.setItem('eots_active_project_name', App.project.metadata.title || 'documento.json');
    } catch (storageErr) {
      console.debug('Error guardando en localStorage:', storageErr);
    }

    // Si hay carpeta de trabajo conectada (Chrome/Edge en PC), guardar físicamente en disco
    if (App.dirHandle) {
      const json = JSON.stringify(payload, null, 2);
      const fileHandle = await App.dirHandle.getFileHandle('documento.json', { create: true });
      const writable   = await fileHandle.createWritable();
      await writable.write(json);
      await writable.close();
    }

    App.ui.isDirty = false;
    updateSaveStatus('saved', App.project.metadata.last_saved);

  } catch (err) {
    console.error('Error al guardar:', err);
    updateSaveStatus('error');
    showToast('Error al guardar automáticamente: ' + err.message, 'error');
  }
}

/* ================================================================
   FIRMA CRIPTOGRÁFICA (SHA-256) PARA DETECTAR MANIPULACIÓN
   ================================================================ */

async function signPayload(payload) {
  const clone = structuredClone(payload);
  delete clone._signature;
  // Usamos una clave estática derivada de la versión de la app
  // (no es criptografía fuerte, pero detecta edición manual del JSON)
  const secret = 'EyeOnTheSky-v1-integrity';
  const data   = secret + JSON.stringify(clone);
  const msgBuf = new TextEncoder().encode(data);
  const hashBuf = await crypto.subtle.digest('SHA-256', msgBuf);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function verifySignature(payload) {
  const stored = payload._signature;
  const expected = await signPayload(payload);
  return stored === expected;
}

/* ================================================================
   GESTIÓN DE FUENTES BIBLIOGRÁFICAS
   ================================================================ */

function openAddSourceModal(editId = null) {
  App.ui.editingSourceId = editId;
  clearSourceForm();

  if (editId) {
    const src = App.project.sources.find(s => s.id === editId);
    if (src) populateSourceForm(src);
    document.getElementById('modal-source-title').textContent = 'Editar fuente';
  } else {
    document.getElementById('modal-source-title').textContent = 'Agregar fuente bibliográfica';
  }

  openModal('modal-source-overlay');
}

function clearSourceForm() {
  ['source-doi-search','source-title','source-authors','source-year',
   'source-doi','source-journal','source-pages'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('source-type').value = 'journal';
  document.getElementById('source-citation-style').value = 'chicago-note';
  document.getElementById('screenshot-preview').classList.add('hidden');
  document.getElementById('source-screenshot-dropzone').classList.remove('hidden');
  document.getElementById('screenshot-preview-img').src = '';
  App.ui.pendingScreenshot = null;
}

function populateSourceForm(src) {
  document.getElementById('source-type').value = src.type || 'journal';
  document.getElementById('source-title').value = src.title || '';
  document.getElementById('source-authors').value = (src.authors || []).join('; ');
  document.getElementById('source-year').value = src.year || '';
  document.getElementById('source-doi').value = src.doi || '';
  document.getElementById('source-journal').value = src.journal || '';
  document.getElementById('source-pages').value = src.pages || '';
  document.getElementById('source-citation-style').value = src.citation_style || 'chicago-note';
}

async function saveSource() {
  const title   = document.getElementById('source-title').value.trim();
  const authors = document.getElementById('source-authors').value.trim();
  const year    = document.getElementById('source-year').value.trim();

  if (!title || !authors || !year) {
    showToast('Completa los campos obligatorios: Título, Autor(es) y Año.', 'warning');
    return;
  }

  const source = {
    id:             App.ui.editingSourceId || generateId(),
    type:           document.getElementById('source-type').value,
    title,
    authors:        authors.split(';').map(a => a.trim()).filter(Boolean),
    year:           parseInt(year),
    doi:            document.getElementById('source-doi').value.trim(),
    journal:        document.getElementById('source-journal').value.trim(),
    pages:          document.getElementById('source-pages').value.trim(),
    citation_style: document.getElementById('source-citation-style').value,
    screenshot_filename: null,
    cited_in_text:  false,
    added_at:       new Date().toISOString(),
  };

  // Si hay captura pendiente, copiarla a la carpeta capturas/
  if (App.ui.pendingScreenshot && App.capturasHandle) {
    const ext      = App.ui.pendingScreenshot.file.name.split('.').pop();
    const filename = `captura_${source.id}.${ext}`;
    try {
      const fh  = await App.capturasHandle.getFileHandle(filename, { create: true });
      const wr  = await fh.createWritable();
      await wr.write(App.ui.pendingScreenshot.file);
      await wr.close();
      source.screenshot_filename = filename;
    } catch (err) {
      showToast('No se pudo guardar la captura: ' + err.message, 'error');
    }
  } else if (App.ui.editingSourceId) {
    // Conservar captura existente si no se cambió
    const existing = App.project.sources.find(s => s.id === App.ui.editingSourceId);
    if (existing) source.screenshot_filename = existing.screenshot_filename;
  }

  // Agregar o reemplazar
  if (App.ui.editingSourceId) {
    const idx = App.project.sources.findIndex(s => s.id === App.ui.editingSourceId);
    if (idx >= 0) App.project.sources[idx] = source;
  } else {
    App.project.sources.push(source);
  }

  closeModal('modal-source-overlay');
  renderSourcesList();
  populateCitationSelect();
  updateTelemetryUI();
  App.ui.isDirty = true;
  updateSaveStatus('unsaved');
  SoundFx.play('source_captured');
  showToast('Fuente guardada correctamente.', 'success');
}

function deleteSource(id) {
  if (!confirm('¿Eliminar esta fuente? Esta acción no se puede deshacer.')) return;
  App.project.sources = App.project.sources.filter(s => s.id !== id);
  renderSourcesList();
  populateCitationSelect();
  updateTelemetryUI();
  App.ui.isDirty = true;
  showToast('Fuente eliminada.', 'success');
}

function renderSourcesList() {
  const container = document.getElementById('sources-list');
  if (App.project.sources.length === 0) {
    container.innerHTML = `<p class="text-sm text-muted" style="padding: 8px 4px;">
      Aún no hay fuentes registradas. Haz clic en <strong>+</strong> para agregar la primera.
    </p>`;
    return;
  }

  container.innerHTML = '';
  App.project.sources.forEach(src => {
    const authorShort = src.authors && src.authors.length > 0
      ? (src.authors[0].split(',')[0] + (src.authors.length > 1 ? ' et al.' : ''))
      : 'Autor desconocido';

    const card = document.createElement('div');
    card.className = 'source-card fade-in';
    card.dataset.id = src.id;
    card.innerHTML = `
      <div class="source-card-title">${escapeHtml(src.title)}</div>
      <div class="source-card-meta">
        <span>${escapeHtml(authorShort)}</span>
        <span>${src.year || '—'}</span>
        ${src.doi ? `<span title="${escapeHtml(src.doi)}">DOI ✓</span>` : ''}
      </div>
      <div style="margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap;">
        <span class="source-card-badge">${typeLabel(src.type)}</span>
        ${src.screenshot_filename
          ? `<span class="source-card-badge has-screenshot">📸 Captura</span>`
          : `<span class="source-card-badge" style="background:var(--warning-light);color:var(--warning);">Sin captura</span>`}
        ${src.cited_in_text ? `<span class="source-card-badge">Citado en texto</span>` : ''}
      </div>
      <div class="source-card-actions">
        <button class="btn btn-sm btn-ghost" onclick="openAddSourceModal('${src.id}')">Editar</button>
        <button class="btn btn-sm btn-ghost" onclick="insertCitationFromSource('${src.id}')">Citar</button>
        <button class="btn btn-sm btn-ghost text-danger" onclick="deleteSource('${src.id}')">Eliminar</button>
        ${src.screenshot_filename ? `<button class="btn btn-sm btn-ghost" onclick="viewScreenshot('${src.id}')">Ver captura</button>` : ''}
      </div>
    `;
    container.appendChild(card);
  });
}

async function viewScreenshot(sourceId) {
  const src = App.project.sources.find(s => s.id === sourceId);
  if (!src || !src.screenshot_filename || !App.capturasHandle) return;

  try {
    const fh   = await App.capturasHandle.getFileHandle(src.screenshot_filename);
    const file = await fh.getFile();
    const url  = URL.createObjectURL(file);
    window.open(url, '_blank');
  } catch (err) {
    showToast('No se encontró la captura en la carpeta del proyecto.', 'error');
  }
}

/* ================================================================
   INSERCIÓN DE CITAS EN EL TEXTO
   ================================================================ */

function populateCitationSelect() {
  const select = document.getElementById('citation-source-select');
  select.innerHTML = '<option value="">— Elige una fuente registrada —</option>';
  App.project.sources.forEach(src => {
    const opt = document.createElement('option');
    opt.value = src.id;
    const author = src.authors && src.authors.length > 0 ? src.authors[0].split(',')[0] : 'Anón.';
    opt.textContent = `${author} (${src.year}) — ${src.title.substring(0, 50)}${src.title.length > 50 ? '…' : ''}`;
    select.appendChild(opt);
  });
}

function formatCitation(src, pages, style) {
  const authors = src.authors || [];
  const year    = src.year || 'S.f.';
  const title   = src.title || '';
  const journal = src.journal || '';
  const pg      = pages ? (`, ${pages}`) : '';

  if (style === 'chicago-note' || style === 'chicago-author-date') {
    // Chicago nota completa
    const authorStr = authors.length > 0
      ? authors.map((a,i) => i === 0 ? a : reverseAuthorName(a)).join(', ')
      : 'Autor desconocido';
    if (src.type === 'journal') {
      return `${authorStr}, "${title}," <em>${journal}</em> (${year})${pg}.`;
    }
    return `${authorStr}, <em>${title}</em> (${year})${pg}.`;
  }

  if (style === 'apa') {
    const authorStr = authors.map(a => {
      const parts = a.split(',');
      return parts.length > 1 ? `${parts[0].trim()}, ${parts[1].trim().charAt(0)}.` : a;
    }).join(', ');
    return `(${authorStr}, ${year}${pg})`;
  }

  if (style === 'mla') {
    return `(${authors[0] ? authors[0].split(',')[0] : 'Anón.'} ${pg.replace(', ','')})`;
  }

  return `(${authors[0] ? authors[0].split(',')[0] : 'Anón.'}, ${year}${pg})`;
}

function reverseAuthorName(name) {
  const parts = name.split(',');
  return parts.length > 1 ? `${parts[1].trim()} ${parts[0].trim()}` : name;
}

function openCitationModal(sourceId = null) {
  populateCitationSelect();
  if (sourceId) document.getElementById('citation-source-select').value = sourceId;
  document.getElementById('citation-page').value = '';
  updateCitationPreview();
  openModal('modal-citation-overlay');
}

function insertCitationFromSource(sourceId) {
  openCitationModal(sourceId);
}

function updateCitationPreview() {
  const srcId = document.getElementById('citation-source-select').value;
  const pages = document.getElementById('citation-page').value.trim();
  const preview = document.getElementById('citation-preview');

  if (!srcId) {
    preview.innerHTML = 'Selecciona una fuente para ver la cita generada.';
    return;
  }

  const src   = App.project.sources.find(s => s.id === srcId);
  if (!src) return;

  const style = src.citation_style || 'chicago-note';
  preview.innerHTML = formatCitation(src, pages, style);
}

function insertCitationIntoEditor() {
  const srcId = document.getElementById('citation-source-select').value;
  const pages = document.getElementById('citation-page').value.trim();

  if (!srcId) {
    showToast('Selecciona una fuente antes de insertar.', 'warning');
    return;
  }

  const src   = App.project.sources.find(s => s.id === srcId);
  if (!src) return;

  const style    = src.citation_style || 'chicago-note';
  const citation = formatCitation(src, pages, style);

  // Insertar en la posición actual del cursor
  const range = App.quill.getSelection(true);
  App.quill.insertText(range.index, citation, 'user');
  App.quill.formatText(range.index, citation.length, 'background', 'rgba(139, 92, 246, 0.20)');
  App.quill.setSelection(range.index + citation.length);

  // Marcar fuente como citada
  src.cited_in_text = true;

  closeModal('modal-citation-overlay');
  updateTelemetryUI();
  App.ui.isDirty = true;
  showToast('Cita insertada.', 'success');
}

/* ================================================================
   INSERCIÓN DE CAPTURAS PDF EN EL EDITOR
   ================================================================ */

async function insertScreenshotAtCursor() {
  if (!App.capturasHandle) {
    showToast('Primero debes abrir o crear un proyecto (carpeta).', 'warning');
    return;
  }

  // Crear un input temporal para seleccionar imagen
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    await embedScreenshotInEditor(file);
  };
  input.click();
}

async function embedScreenshotInEditor(file) {
  try {
    // Guardar en carpeta capturas/
    const ext      = file.name.split('.').pop();
    const filename = `captura_${Date.now()}.${ext}`;
    const fh  = await App.capturasHandle.getFileHandle(filename, { create: true });
    const wr  = await fh.createWritable();
    await wr.write(file);
    await wr.close();

    // Crear blob URL para mostrar en el editor (sesión actual)
    const blobUrl = URL.createObjectURL(file);

    // Insertar como bloque colapsable (details/summary) en el HTML
    const range = App.quill.getSelection(true);
    // Quill no soporta natively <details>, así que insertamos un marcador
    // y lo reemplazamos en el HTML final para exportación
    const placeholder = `[📸 Captura: ${filename}]`;
    App.quill.insertText(range.index, placeholder, { bold: false, italic: true, color: '#4a6cf7' }, 'user');

    // Guardar referencia en el proyecto
    if (!App.project.inline_screenshots) App.project.inline_screenshots = {};
    App.project.inline_screenshots[placeholder] = {
      filename,
      inserted_at: new Date().toISOString(),
      blob_url: blobUrl,
    };

    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
    showToast(`Captura "${filename}" incrustada en el texto.`, 'success');

  } catch (err) {
    showToast('Error al insertar la captura: ' + err.message, 'error');
  }
}

/* ================================================================
   BÚSQUEDA POR DOI (Crossref API)
   ================================================================ */

async function fetchDOI() {
  const doi = document.getElementById('source-doi-search').value.trim();
  if (!doi) {
    showToast('Ingresa un DOI para buscar.', 'warning');
    return;
  }

  const btn = document.getElementById('btn-fetch-doi');
  btn.textContent = 'Buscando…';
  btn.disabled = true;

  try {
    const cleanDoi = doi.replace('https://doi.org/', '').replace('http://dx.doi.org/', '');
    const url  = `https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('DOI no encontrado en Crossref.');

    const data = await resp.json();
    const item = data.message;

    document.getElementById('source-title').value = (item.title && item.title[0]) || '';
    document.getElementById('source-doi').value   = cleanDoi;
    document.getElementById('source-year').value  = item.published?.['date-parts']?.[0]?.[0] || '';
    document.getElementById('source-journal').value = item['container-title']?.[0] || '';
    document.getElementById('source-pages').value = item.page || '';

    if (item.author && item.author.length > 0) {
      const authors = item.author.map(a => `${a.family || ''}, ${a.given || ''}`.trim());
      document.getElementById('source-authors').value = authors.join('; ');
    }

    // Detectar tipo
    const typeMap = { 'journal-article': 'journal', 'book': 'book', 'book-chapter': 'chapter' };
    document.getElementById('source-type').value = typeMap[item.type] || 'journal';

    showToast('Datos obtenidos de Crossref correctamente.', 'success');

  } catch (err) {
    showToast('No se encontró el DOI: ' + err.message, 'error');
  } finally {
    btn.textContent = 'Buscar';
    btn.disabled = false;
  }
}

/* ================================================================
   EXPORTACIÓN
   ================================================================ */

// --- PDF (usa el CSS de impresión definido en styles.css) ---
function exportToPDF() {
  SoundFx.play('export_success');
  window.print();
}

// --- Word (.docx) usando la librería docx ---
async function exportToDocx() {
  if (!window.docx) {
    showToast('Librería DOCX no disponible. Verifica tu conexión a internet.', 'error');
    return;
  }

  showToast('Generando documento Word…', 'success');

  const { Document, Paragraph, TextRun, HeadingLevel, Packer, AlignmentType } = window.docx;

  const title    = App.project.metadata.title || 'Sin título';
  const htmlText = App.quill.getText();
  const lines    = htmlText.split('\n').filter(l => l.trim());

  const paragraphs = lines.map(line => {
    return new Paragraph({ children: [new TextRun(line)], spacing: { after: 200 } });
  });

  // Bibliografía al final
  const bibParagraphs = [
    new Paragraph({ text: 'Bibliografía', heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }),
  ];

  App.project.sources.forEach(src => {
    const citation = formatCitation(src, '', src.citation_style || 'chicago-note');
    const cleanText = citation.replace(/<\/?em>/g, '').replace(/<[^>]+>/g, '');
    bibParagraphs.push(new Paragraph({
      children: [new TextRun(cleanText)],
      spacing: { after: 150 },
    }));
  });

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: title, heading: HeadingLevel.TITLE, spacing: { after: 300 } }),
        ...paragraphs,
        ...bibParagraphs,
      ],
    }],
  });

  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, `${slugify(title)}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  SoundFx.play('export_success');
  showToast('Documento Word exportado.', 'success');
}

// --- Bibliografía en formato RIS (para Zotero) ---
function exportToRIS() {
  if (App.project.sources.length === 0) {
    showToast('No hay fuentes registradas para exportar.', 'warning');
    return;
  }

  const typeMap = {
    journal:    'JOUR',
    book:       'BOOK',
    chapter:    'CHAP',
    thesis:     'THES',
    conference: 'CONF',
    website:    'ELEC',
    report:     'RPRT',
  };

  let ris = '';

  App.project.sources.forEach(src => {
    ris += `TY  - ${typeMap[src.type] || 'GEN'}\n`;
    (src.authors || []).forEach(a => { ris += `AU  - ${a}\n`; });
    ris += `TI  - ${src.title || ''}\n`;
    ris += `PY  - ${src.year || ''}\n`;
    if (src.journal) ris += `JO  - ${src.journal}\n`;
    if (src.doi)     ris += `DO  - ${src.doi}\n`;
    if (src.pages)   ris += `SP  - ${src.pages}\n`;
    ris += `ER  - \n\n`;
  });

  const blob = new Blob([ris], { type: 'application/x-research-info-systems' });
  const title = App.project.metadata.title || 'documento';
  downloadBlob(blob, `${slugify(title)}_bibliografia.ris`, 'application/x-research-info-systems');
  SoundFx.play('export_success');
  showToast('Bibliografía exportada en formato RIS (compatible con Zotero).', 'success');
}

// --- Copia de seguridad del JSON ---
async function exportJSON() {
  await saveProject(); // guardar primero
  const payload = structuredClone(App.project);
  payload._signature = await signPayload(payload);
  const blob  = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const title = App.project.metadata.title || 'documento';
  downloadBlob(blob, `${slugify(title)}_respaldo.json`, 'application/json');
  SoundFx.play('export_success');
  showToast('Copia del proyecto descargada.', 'success');
}

/* ================================================================
   UTILIDADES
   ================================================================ */

function downloadBlob(blob, filename, type) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

function updateWordCount(count) {
  document.getElementById('sb-word-count').textContent = `${count} palabras`;
}

function updateSaveStatus(state, isoDate) {
  const el   = document.getElementById('save-status');
  const text = document.getElementById('save-status-text');
  el.classList.remove('saving', 'unsaved', 'error');

  if (state === 'saving') {
    el.classList.add('saving');
    text.textContent = 'Guardando…';
  } else if (state === 'saved') {
    const t = isoDate ? new Date(isoDate).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
    text.textContent = `Guardado ${t}`;
  } else if (state === 'unsaved') {
    el.classList.add('unsaved');
    text.textContent = 'Sin guardar';
  } else if (state === 'error') {
    el.classList.add('error');
    text.textContent = 'Error al guardar';
  }
}

function generateId() {
  return 'src-' + Math.random().toString(36).slice(2, 11);
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'').substring(0,60) || 'documento';
}

function typeLabel(type) {
  const map = { journal:'Artículo', book:'Libro', chapter:'Capítulo', thesis:'Tesis',
    conference:'Ponencia', website:'Web', report:'Reporte' };
  return map[type] || type;
}

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type} fade-in`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function restoreTheme() {
  const saved = localStorage.getItem('eots-theme') || 'light';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  App.ui.currentTheme = theme;
  localStorage.setItem('eots-theme', theme);
  document.getElementById('theme-icon-light').classList.toggle('hidden', theme === 'dark');
  document.getElementById('theme-icon-dark').classList.toggle('hidden', theme === 'light');
}

/* ================================================================
   EVENT LISTENERS
   ================================================================ */

function initEventListeners() {

  // Onboarding
  document.getElementById('onboard-new').addEventListener('click', () => openOrCreateProject('new'));
  document.getElementById('onboard-open').addEventListener('click', () => openOrCreateProject('open'));

  // Cerrar modal de onboarding con botón ✕ (continuar sin carpeta)
  const btnCloseOnboard = document.getElementById('close-modal-onboarding');
  if (btnCloseOnboard) {
    btnCloseOnboard.addEventListener('click', () => {
      closeModal('modal-onboarding-overlay');
      showToast('Modo de prueba activo. Recuerda exportar tu proyecto para no perder cambios.', 'info');
    });
  }

  // Carga directa mediante input file nativo (onboard-file-input)
  const inputOnboardFile = document.getElementById('onboard-file-input');
  if (inputOnboardFile) {
    inputOnboardFile.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        await loadProjectFromJSONFile(file);
        try { inputOnboardFile.value = ''; } catch (_) {}
      }
    });
  }

  // Botón para cargar JSON pegado como texto (respaldo para iPhone y Android)
  const btnLoadPastedJson = document.getElementById('btn-load-pasted-json');
  if (btnLoadPastedJson) {
    btnLoadPastedJson.addEventListener('click', () => {
      const textarea = document.getElementById('paste-json-textarea');
      if (textarea) {
        loadProjectFromJSONText(textarea.value);
      }
    });
  }

  // Soporte de arrastrar y soltar (Drag and Drop) de archivos .json en el modal
  const onboardModal = document.getElementById('modal-onboarding-overlay');
  if (onboardModal) {
    const modalBox = onboardModal.querySelector('.modal');
    onboardModal.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (modalBox) modalBox.style.borderColor = 'var(--accent)';
    });
    onboardModal.addEventListener('dragleave', () => {
      if (modalBox) modalBox.style.borderColor = 'var(--border)';
    });
    onboardModal.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (modalBox) modalBox.style.borderColor = 'var(--border)';
      const files = e.dataTransfer?.files;
      if (files && files[0] && files[0].name.endsWith('.json')) {
        await loadProjectFromJSONFile(files[0]);
      }
    });
  }

  // Carga alternativa directa desde el topbar
  const inputLoadJsonDirect = document.getElementById('input-load-json-direct');
  if (inputLoadJsonDirect) {
    inputLoadJsonDirect.addEventListener('change', async () => {
      if (inputLoadJsonDirect.files && inputLoadJsonDirect.files[0]) {
        await loadProjectFromJSONFile(inputLoadJsonDirect.files[0]);
      }
    });
  }

  // Botón abrir carpeta (topbar)
  document.getElementById('btn-open-folder').addEventListener('click', () => openOrCreateProject('open'));

  // Toggle sidebars
  document.getElementById('btn-toggle-sources').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar-sources');
    App.ui.sourcesPanelOpen = !App.ui.sourcesPanelOpen;
    sidebar.classList.toggle('collapsed', !App.ui.sourcesPanelOpen);
  });

  document.getElementById('btn-toggle-tele').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar-telemetry');
    App.ui.telePanelOpen = !App.ui.telePanelOpen;
    sidebar.classList.toggle('collapsed', !App.ui.telePanelOpen);
  });

  // Tema
  document.getElementById('btn-theme').addEventListener('click', () => {
    applyTheme(App.ui.currentTheme === 'light' ? 'dark' : 'light');
  });

  // Título del documento
  document.getElementById('doc-title-input').addEventListener('input', () => {
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
    document.title = `${document.getElementById('doc-title-input').value || 'Sin título'} — Eye on the Sky`;
  });

  // Menú de exportación
  const exportBtn  = document.getElementById('btn-export-menu');
  const exportMenu = document.getElementById('export-menu');

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.classList.toggle('open');
  });

  document.addEventListener('click', () => exportMenu.classList.remove('open'));

  document.getElementById('export-pdf').addEventListener('click',  exportToPDF);
  document.getElementById('export-docx').addEventListener('click', exportToDocx);
  document.getElementById('export-ris').addEventListener('click',  exportToRIS);
  document.getElementById('export-json').addEventListener('click', exportJSON);

  // Agregar fuente
  document.getElementById('btn-add-source').addEventListener('click', () => openAddSourceModal());
  document.getElementById('btn-insert-citation').addEventListener('click', () => openCitationModal());
  document.getElementById('btn-insert-screenshot').addEventListener('click', insertScreenshotAtCursor);

  // Modal fuente
  document.getElementById('save-source').addEventListener('click', saveSource);
  document.getElementById('cancel-source').addEventListener('click', () => closeModal('modal-source-overlay'));
  document.getElementById('close-modal-source').addEventListener('click', () => closeModal('modal-source-overlay'));
  document.getElementById('btn-fetch-doi').addEventListener('click', fetchDOI);

  // Drop zone de captura en modal fuente
  const dropZone = document.getElementById('source-screenshot-dropzone');
  const fileInput = document.getElementById('source-screenshot-input');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) previewScreenshot(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) previewScreenshot(fileInput.files[0]);
  });

  document.getElementById('remove-screenshot').addEventListener('click', () => {
    App.ui.pendingScreenshot = null;
    document.getElementById('screenshot-preview').classList.add('hidden');
    document.getElementById('source-screenshot-dropzone').classList.remove('hidden');
  });

  // Importar BibTeX
  document.getElementById('btn-parse-bibtex').addEventListener('click', importBibtex);

  // Modal cita
  document.getElementById('close-modal-citation').addEventListener('click', () => closeModal('modal-citation-overlay'));
  document.getElementById('cancel-citation').addEventListener('click', () => closeModal('modal-citation-overlay'));
  document.getElementById('insert-citation-btn').addEventListener('click', insertCitationIntoEditor);
  document.getElementById('citation-source-select').addEventListener('change', updateCitationPreview);
  document.getElementById('citation-page').addEventListener('input', updateCitationPreview);

  // Control de efectos de sonido
  const btnSound = document.getElementById('btn-sound-toggle');
  if (btnSound) btnSound.addEventListener('click', () => SoundFx.toggle());

  // Toggle mapa de procedencia del texto
  const btnToggleColor = document.getElementById('btn-toggle-color-map');
  if (btnToggleColor) {
    btnToggleColor.addEventListener('click', () => {
      const editorWrapper = document.getElementById('quill-editor');
      if (!editorWrapper) return;
      const isHidden = editorWrapper.classList.toggle('hide-provenance');
      btnToggleColor.textContent = isHidden ? 'Mostrar' : 'Ocultar';
      btnToggleColor.title = isHidden ? 'Mostrar colores de procedencia' : 'Ocultar colores de procedencia';
    });
  }

  // Modal huella biométrica calibrada
  const btnCloseBio = document.getElementById('close-modal-bio');
  if (btnCloseBio) btnCloseBio.addEventListener('click', () => closeModal('modal-biometrics-overlay'));
  const btnConfirmBio = document.getElementById('btn-confirm-bio');
  if (btnConfirmBio) btnConfirmBio.addEventListener('click', () => closeModal('modal-biometrics-overlay'));

  // Cerrar modales con Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ['modal-source-overlay','modal-citation-overlay','modal-biometrics-overlay'].forEach(id => closeModal(id));
    }
  });

  // Guardar con Ctrl+S
  document.addEventListener('keydown', async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      await saveProject();
      SoundFx.play('autosave_peace');
    }
  });

  // Guardado automático al cambiar de pestaña o minimizar ventana
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && App.ui.isDirty && App.dirHandle) {
      saveProject();
    }
  });

  // Aviso antes de cerrar si hay cambios
  window.addEventListener('beforeunload', (e) => {
    if (App.ui.isDirty && App.ui.projectLoaded) {
      if (App.dirHandle) saveProject();
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function previewScreenshot(file) {
  App.ui.pendingScreenshot = { file, previewUrl: URL.createObjectURL(file) };
  document.getElementById('screenshot-preview-img').src = App.ui.pendingScreenshot.previewUrl;
  document.getElementById('screenshot-preview').classList.remove('hidden');
  document.getElementById('source-screenshot-dropzone').classList.add('hidden');
}

/* ================================================================
   IMPORTACIÓN BIBTEX
   ================================================================ */

/**
 * Parsea una cadena BibTeX y devuelve un array de entradas.
 * Soporta múltiples entradas en el mismo texto (importación en lote).
 */
function parseBibtex(text) {
  const entries = [];
  // Dividir en bloques individuales por cada @tipo{
  const blocks = text.split(/(?=@\w+\s*\{)/).filter(b => /^@\w/.test(b.trim()));

  for (const block of blocks) {
    try {
      // Extraer tipo y clave
      const header = block.match(/^@(\w+)\s*\{\s*([^,\s]+)\s*,/);
      if (!header) continue;

      const type = header[1].toLowerCase();
      if (['string', 'preamble', 'comment'].includes(type)) continue;

      const key = header[2].trim();

      // Extraer cuerpo (todo después de la primera coma hasta el último })
      const commaIdx = block.indexOf(',', block.indexOf('{'));
      const lastBrace = block.lastIndexOf('}');
      if (commaIdx < 0 || lastBrace < 0) continue;
      const body = block.slice(commaIdx + 1, lastBrace);

      // Parsear campos: nombre = {valor} | "valor" | número
      const fields = {};
      // Regex que soporta un nivel de anidamiento de llaves
      const fieldRe = /(\w+)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|([0-9]+))/g;
      let fm;
      while ((fm = fieldRe.exec(body)) !== null) {
        const fname = fm[1].toLowerCase();
        let   fval  = (fm[2] ?? fm[3] ?? fm[4] ?? '').trim();
        // Limpiar comandos LaTeX básicos y llaves sobrantes
        fval = fval
          .replace(/\\[`'^~"=.][{]?([a-zA-Z])[}]?/g, '$1') // acentos LaTeX
          .replace(/\\[a-zA-Z]+\{([^}]+)\}/g, '$1')          // comandos con arg
          .replace(/\\[a-zA-Z]+/g, '')                        // comandos sin arg
          .replace(/[{}]/g, '')
          .replace(/--/g, '–')
          .replace(/\s+/g, ' ')
          .trim();
        fields[fname] = fval;
      }

      entries.push({ type, key, fields });
    } catch (err) {
      console.warn('Error al parsear entrada BibTeX:', err);
    }
  }

  return entries;
}

/** Convierte una entrada BibTeX parseada al formato de fuente de la app */
function bibtexEntryToSource(entry) {
  const f = entry.fields;

  // Autores: "Apellido, Nombre and Apellido2, Nombre2"
  const authorsRaw = f.author || f.editor || '';
  const authors = authorsRaw
    .split(/ and /i)
    .map(a => a.trim())
    .filter(Boolean);

  const typeMap = {
    article:       'journal',
    book:          'book',
    incollection:  'chapter',
    inproceedings: 'conference',
    proceedings:   'conference',
    phdthesis:     'thesis',
    mastersthesis: 'thesis',
    misc:          'website',
    techreport:    'report',
    unpublished:   'report',
  };

  return {
    id:               generateId(),
    type:             typeMap[entry.type] || 'journal',
    title:            f.title || f.booktitle || '',
    authors,
    year:             parseInt(f.year) || null,
    doi:              f.doi || f.url || '',
    journal:          f.journal || f.booktitle || f.publisher || f.school || '',
    pages:            (f.pages || '').replace(/--/g, '-'),
    citation_style:   'chicago-note',
    screenshot_filename: null,
    cited_in_text:    false,
    added_at:         new Date().toISOString(),
    bibtex_key:       entry.key,
  };
}

/** Importa todas las entradas BibTeX del textarea al proyecto */
function importBibtex() {
  const raw      = document.getElementById('bibtex-input').value.trim();
  const resultEl = document.getElementById('bibtex-import-result');

  if (!raw) {
    resultEl.textContent = 'Pega al menos una entrada BibTeX primero.';
    resultEl.className = 'text-sm text-warning mt-1';
    return;
  }

  const entries = parseBibtex(raw);

  if (entries.length === 0) {
    resultEl.textContent = 'No se encontraron entradas BibTeX válidas. Verifica el formato.';
    resultEl.className = 'text-sm text-danger mt-1';
    return;
  }

  let added = 0;
  let skipped = 0;

  entries.forEach(entry => {
    // Evitar duplicados por clave BibTeX
    const exists = App.project.sources.some(s => s.bibtex_key === entry.key);
    if (exists) { skipped++; return; }

    App.project.sources.push(bibtexEntryToSource(entry));
    added++;
  });

  renderSourcesList();
  populateCitationSelect();
  updateTelemetryUI();
  App.ui.isDirty = true;
  updateSaveStatus('unsaved');

  // Limpiar textarea
  document.getElementById('bibtex-input').value = '';

  resultEl.textContent = `✓ ${added} fuente(s) importada(s)${skipped > 0 ? `, ${skipped} omitida(s) por duplicado` : ''}.`;
  resultEl.className = 'text-sm text-success mt-1';

  if (added > 0) {
    showToast(`${added} fuente(s) BibTeX importada(s).`, 'success');
    // No cerrar el modal si se importaron varias (el usuario puede querer revisar)
    if (entries.length === 1) closeModal('modal-source-overlay');
  }
}
