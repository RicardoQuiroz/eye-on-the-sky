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

const APP_VERSION = '2.0.0';
const SCHEMA_VERSION = 2;

function generateProjectId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return 'prj_' + crypto.randomUUID();
  return 'prj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/**
 * Plantilla limpia de un proyecto. Se usa al crear un documento nuevo y como base
 * al cargar un JSON, para que ningún dato del proyecto anterior (fuentes, huella
 * biométrica, capturas…) se filtre al proyecto recién abierto.
 */
function freshProjectTemplate() {
  return {
    metadata: {
      project_id:    generateProjectId(),
      title:         '',
      course:        'Seminario de Grado',
      student_name:  '',
      student_email: '',
      citation_style: '',            // estilo de la bibliografía ('' = el más usado en las fuentes)
      created_at:    new Date().toISOString(),
      last_saved:    null,
      app_version:   APP_VERSION,
      schema_version: SCHEMA_VERSION,
    },
    content:   { delta: null, html: '' },
    sources:   [],
    captures:  {},                   // registro de capturas: { nombre: { sha256, mime, size, … } }
    telemetry: {
      sessions: [],
      summary: {
        total_sessions: 0, total_days_active: 0, total_words_typed: 0,
        total_chars_pasted: 0, manual_ratio: 0,
        sources_with_screenshot: 0, sources_cited_in_text: 0,
      }
    },
    biometrics: {
      baselines: { keyboard: null }, // huella SOLO con teclado físico
      baseline: null,                // espejo de baselines.keyboard (compatibilidad)
      session_metrics: null,
    }
  };
}

// Colores de procedencia: definidos en analytics.js (compartido con el dashboard)
const PROVENANCE_BG = {
  paste:    EOTS.PROVENANCE.paste.bg,
  notes:    EOTS.PROVENANCE.notes.bg,
  quote:    EOTS.PROVENANCE.quote.bg,
  ai:       EOTS.PROVENANCE.ai.bg,
  citation: EOTS.PROVENANCE.citation.bg,
};
const isProvenanceBackground = EOTS.isProvenanceBackground;

/** Dispositivo actual: id estable por navegador, clase de entrada y etiqueta legible. */
function getDeviceInfo() {
  let id = null;
  try {
    id = localStorage.getItem('eots-device-id');
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('eots-device-id', id);
    }
  } catch (_) { id = 'dev_sin_almacenamiento'; }
  const ua = navigator.userAgent || '';
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  const fine = window.matchMedia && matchMedia('(any-pointer: fine)').matches;
  const isTouch = (navigator.maxTouchPoints || 0) > 0 && coarse && !fine;
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
    : /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Otro';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  return { id, class: isTouch ? 'touch' : 'keyboard', label: `${os} · ${browser}${isTouch ? ' (táctil)' : ''}` };
}

function freshProcessStats() {
  return {
    text_keys: 0,        // teclas de texto pulsadas (sin atajos)
    backspaces: 0,       // pulsaciones de Retroceso / Suprimir
    chars_typed: 0,      // caracteres insertados tecleando
    chars_deleted: 0,    // caracteres borrados
    nonlinear_edits: 0,  // ediciones lejos del punto anterior (volver a revisar texto previo)
    pauses_2s: 0,        // pausas de 2 a 30 s entre teclas (planificación)
    active_ms: 0,        // tiempo de tecleo efectivo (huecos < 30 s)
  };
}

const App = {
  // Handles del sistema de archivos
  dirHandle:      null,   // FileSystemDirectoryHandle del proyecto
  capturasHandle: null,   // FileSystemDirectoryHandle de subcarpeta capturas/
  jsonFileHandle: null,   // FileSystemFileHandle del .json o .zip abierto individualmente (PC)
  jsonFileName:   'documento.json', // nombre del .json dentro de la carpeta vinculada

  device: null,           // getDeviceInfo()

  // Datos del proyecto (lo que se serializa a JSON)
  project: freshProjectTemplate(),

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
    timer_ref:         null,
    autosave_ref:      null,
    previousWordCount: 0,  // para calcular diff de palabras real
    isPasting:         false, // flag para text-change: ignorar palabras de paste
    isUndoRedo:        false, // flag: el cambio proviene de Ctrl+Z / Ctrl+Y (no es escritura ni pegado)
    isSystemInsert:    false, // flag: inserción hecha por la app (cita, índice, bibliografía, captura)
    passedMilestones:  new Set(),
    process:           freshProcessStats(),
    lastKeyTime:       0,
    lastEditIndex:     null,
    timeline:          [],     // [[seg. desde inicio, caracteres doc, tecleados, pegados]]
    clipboardToken:    Math.random().toString(36).slice(2, 12), // marca de copias internas
    resumed:           false,
    biometrics: {
      activeKeyDowns: new Map(),
      lastKeyUpTime:  0,
      samples:        [],
      spaceDwells:    [],
      backspaceDwells: [],
      notifiedBaseline: false,
      metrics:        null,    // métricas de ESTA sesión (no se arrastran de otra)
    }
  },

  // Flags de UI
  ui: {
    sourcesPanelOpen: true,
    telePanelOpen:    false,
    activeSidebarTab: 'sources', // 'sources' | 'toc'
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
    session_start:   'sounds/session_start.mp3',
    milestone_words: 'sounds/milestone_words.mp3',
    source_captured: 'sounds/source_captured.mp3',
    autosave_peace:  'sounds/autosave_peace.mp3',
    paste_alert:     'sounds/paste_alert.mp3',
    export_success:  'sounds/export_success.mp3',
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
    this.unlockAudioOnFirstUserGesture();
    this.updateUI();
  },

  unlockAudioOnFirstUserGesture() {
    const unlock = () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
      try {
        const dummy = new Audio();
        dummy.volume = 0;
        const p = dummy.play();
        if (p && typeof p.then === 'function') {
          p.then(() => dummy.pause()).catch(() => {});
        }
      } catch (e) {}
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
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
    if (typeof updateMobileMenuUI === 'function') updateMobileMenuUI();
  }
};

/* ================================================================
   MOTOR DE BIOMETRÍA DE ESCRITURA Y DINÁMICA DE TECLEO
   - Solo con TECLADO FÍSICO: en pantallas táctiles los tiempos de pulsación del
     teclado virtual no son comparables (y en Android suelen llegar como
     "Unidentified"), por lo que se desactiva para no generar falsas alarmas.
   - Las métricas son POR SESIÓN: no se arrastran de una sesión a otra.
   - Es un indicador INFORMATIVO, no una prueba de identidad.
   ================================================================ */

const BiometricsEngine = {
  REQUIRED_SAMPLES: EOTS.POLICY.BIO_BASELINE_SAMPLES,

  applies() { return (App.device?.class || 'keyboard') === 'keyboard'; },

  baseline() {
    const b = App.project.biometrics || {};
    return b.baselines?.keyboard || b.baseline || null;
  },

  isUsableKey(e) {
    if (['Shift','Control','Alt','Meta','CapsLock'].includes(e.key)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === 'Unidentified' || e.key === 'Process' || e.keyCode === 229) return false; // teclados virtuales / IME
    if (e.isComposing) return false;
    return true;
  },

  onKeyDown(e) {
    if (!this.applies() || !this.isUsableKey(e)) return;
    const now = performance.now();
    const keyId = e.code || e.key;
    if (!App.session.biometrics.activeKeyDowns.has(keyId)) {
      App.session.biometrics.activeKeyDowns.set(keyId, { time: now, key: e.key });
    }
  },

  onKeyUp(e) {
    if (!this.applies()) return;
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

    const validFlight = (flight !== null && flight >= 10 && flight <= 2500) ? flight : null;

    App.session.biometrics.samples.push({ dwell, flight: validFlight });
    // Limitar memoria en sesiones muy largas (las medias siguen siendo representativas)
    if (App.session.biometrics.samples.length > 5000) App.session.biometrics.samples.shift();

    if (downRec.key === ' ') App.session.biometrics.spaceDwells.push(dwell);
    if (downRec.key === 'Backspace') App.session.biometrics.backspaceDwells.push(dwell);

    this.process();
  },

  process() {
    const samples = App.session.biometrics.samples;
    const baseline = this.baseline();
    if (!baseline) {
      if (samples.length >= this.REQUIRED_SAMPLES && !App.session.biometrics.notifiedBaseline) {
        this.calibrateBaseline(samples);
      } else {
        this.updateUI();
      }
    } else {
      this.verifySession(samples, baseline);
    }
  },

  stats(samples) {
    const d = samples.map(s => s.dwell);
    const f = samples.filter(s => s.flight !== null).map(s => s.flight);
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    const std = (a, m) => a.length ? Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / a.length) : 0;
    const mD = mean(d), mF = f.length ? mean(f) : 150;
    return { meanD: mD, stdD: std(d, mD), meanF: mF, stdF: f.length ? std(f, mF) : 20 };
  },

  calibrateBaseline(samples) {
    App.session.biometrics.notifiedBaseline = true;
    const st = this.stats(samples);
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : st.meanD;
    const r1 = v => Math.round(v * 10) / 10;

    const baseline = {
      established_at:     new Date().toISOString(),
      device_class:       'keyboard',
      device_label:       App.device?.label || '',
      sample_size:        samples.length,
      mean_dwell_ms:      r1(st.meanD),
      std_dwell_ms:       r1(st.stdD),
      mean_flight_ms:     r1(st.meanF),
      std_flight_ms:      r1(st.stdF),
      space_dwell_ms:     r1(mean(App.session.biometrics.spaceDwells)),
      backspace_dwell_ms: r1(mean(App.session.biometrics.backspaceDwells)),
    };
    if (!App.project.biometrics) App.project.biometrics = {};
    if (!App.project.biometrics.baselines) App.project.biometrics.baselines = {};
    App.project.biometrics.baselines.keyboard = baseline;
    App.project.biometrics.baseline = baseline;

    App.session.biometrics.metrics = {
      samples: samples.length, mean_dwell_ms: r1(st.meanD), mean_flight_ms: r1(st.meanF), similarity_score: 100,
    };

    const mDwell = document.getElementById('modal-bio-dwell');
    const mFlight = document.getElementById('modal-bio-flight');
    const mSamples = document.getElementById('modal-bio-samples');
    if (mDwell)   mDwell.textContent   = `${Math.round(st.meanD)} ms`;
    if (mFlight)  mFlight.textContent  = `${Math.round(st.meanF)} ms`;
    if (mSamples) mSamples.textContent = `${samples.length} pulsaciones`;
    openModal('modal-biometrics-overlay');
    SoundFx.play('milestone_words');
    this.updateUI();
    saveProject();
  },

  verifySession(samples, baseline) {
    if (samples.length < EOTS.POLICY.BIO_MIN_SAMPLES) { this.updateUI(); return; }
    const st = this.stats(samples);
    const zD = Math.abs(st.meanD - baseline.mean_dwell_ms) / Math.max(baseline.std_dwell_ms || 20, 10);
    const zF = Math.abs(st.meanF - baseline.mean_flight_ms) / Math.max(baseline.std_flight_ms || 35, 15);
    const dist = 0.5 * zD + 0.5 * zF;
    const similarity = Math.max(0, Math.min(100, Math.round(100 - (dist * 20))));
    App.session.biometrics.metrics = {
      samples: samples.length,
      mean_dwell_ms: Math.round(st.meanD * 10) / 10,
      mean_flight_ms: Math.round(st.meanF * 10) / 10,
      similarity_score: similarity,
    };
    this.updateUI();
  },

  updateUI() {
    const statusEl = document.getElementById('tele-bio-status');
    const dwellEl  = document.getElementById('tele-bio-dwell');
    const flightEl = document.getElementById('tele-bio-flight');
    const simEl    = document.getElementById('tele-bio-similarity');
    const setColor = (el, c) => { if (el) el.style.color = c; };

    if (!this.applies()) {
      if (statusEl) { statusEl.textContent = 'No aplica (pantalla táctil)'; setColor(statusEl, 'var(--text-muted)'); }
      if (dwellEl) dwellEl.textContent = '—';
      if (flightEl) flightEl.textContent = '—';
      if (simEl) { simEl.textContent = '—'; setColor(simEl, 'var(--text-muted)'); }
      return;
    }
    const baseline = this.baseline();
    const sm = App.session.biometrics.metrics;
    if (baseline) {
      if (statusEl) { statusEl.textContent = '✓ Calibrada'; setColor(statusEl, 'var(--success)'); }
      if (dwellEl)  dwellEl.textContent  = `${sm?.mean_dwell_ms ?? baseline.mean_dwell_ms} ms`;
      if (flightEl) flightEl.textContent = `${sm?.mean_flight_ms ?? baseline.mean_flight_ms} ms`;
      if (simEl) {
        if (!sm) { simEl.textContent = 'Midiendo…'; setColor(simEl, 'var(--text-muted)'); }
        else {
          const lvl = EOTS.bioLevel(sm.similarity_score);
          simEl.textContent = `${sm.similarity_score}%`;
          setColor(simEl, lvl === 'ok' ? 'var(--success)' : lvl === 'warning' ? 'var(--warning)' : 'var(--danger)');
        }
      }
    } else {
      const st = this.stats(App.session.biometrics.samples);
      if (statusEl) {
        statusEl.textContent = `Calibrando (${App.session.biometrics.samples.length}/${this.REQUIRED_SAMPLES})`;
        setColor(statusEl, 'var(--accent)');
      }
      if (dwellEl)  dwellEl.textContent  = App.session.biometrics.samples.length ? `${Math.round(st.meanD)} ms` : '—';
      if (flightEl) flightEl.textContent = App.session.biometrics.samples.length ? `${Math.round(st.meanF)} ms` : '—';
      if (simEl)    { simEl.textContent = 'En curso'; setColor(simEl, 'var(--text-muted)'); }
    }
  }
};

/* ================================================================
   INICIALIZACIÓN
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  App.device = getDeviceInfo();
  SoundFx.init();
  initUndoRedoGuard();
  initQuill();
  initEventListeners();
  initSessionTimer();
  restoreTheme();
  adaptUIForPlatform();
  // Solo restaurar si hay proyecto guardado; el modal de onboarding
  // permanece visible en iOS hasta que el usuario interactúe
  checkAndRestoreActiveProject();
});

function checkAndRestoreActiveProject() {
  const saved = localStorage.getItem('eots_active_project');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed && (parsed.content || parsed.metadata)) {
        const name = localStorage.getItem('eots_active_project_name') || 'documento.json';
        // Cargamos el proyecto restaurado tras un breve retardo para que la interfaz se asiente
        setTimeout(() => {
          // Solo si el usuario no abrió otro proyecto mientras tanto
          if (!App.ui.projectLoaded) {
            loadProjectFromParsedJSON(parsed, name, { silentRestore: true }).catch(() => {});
          }
        }, 350);
      }
    } catch (e) {
      console.debug('No se pudo restaurar sesión activa de localStorage:', e);
    }
  }
}

function initQuill() {
  // Registro de formatos personalizados en Quill (Parchment)
  try {
    const Parchment = Quill.import('parchment');
    if (Parchment && Parchment.Attributor) {
      const IndentRightClass = new Parchment.Attributor.Class('indent-right', 'ql-indent-right', {
        scope: Parchment.Scope.BLOCK,
        whitelist: ['1', '2', '3']
      });
      const IndentBothClass = new Parchment.Attributor.Class('indent-both', 'ql-indent-both', {
        scope: Parchment.Scope.BLOCK,
        whitelist: ['1', '2', '3']
      });
      Quill.register(IndentRightClass, true);
      Quill.register(IndentBothClass, true);
    }

    const BlockEmbed = Quill.import('blots/block/embed');
    if (BlockEmbed) {
      class AcademicTableBlot extends BlockEmbed {
        static create(value) {
          const node = super.create();
          node.setAttribute('contenteditable', 'false');
          node.className = 'academic-table-container';
          if (typeof value === 'string') {
            node.innerHTML = value;
          } else if (value && value.html) {
            node.innerHTML = value.html;
          }
          return node;
        }
        static value(node) {
          return { html: node.innerHTML };
        }
      }
      AcademicTableBlot.blotName = 'academic-table';
      AcademicTableBlot.tagName = 'div';
      AcademicTableBlot.className = 'academic-table-container';
      Quill.register(AcademicTableBlot, true);

      /**
       * Captura de evidencia incrustada como IMAGEN real. El documento solo guarda el
       * nombre estable de la captura; la imagen se resuelve desde el almacén portable
       * (IndexedDB / carpeta capturas/), así el enlace sobrevive al cambio de dispositivo.
       */
      class CaptureBlot extends BlockEmbed {
        static create(value) {
          const node = super.create();
          const v = (value && typeof value === 'object') ? value : { filename: String(value || '') };
          node.setAttribute('contenteditable', 'false');
          node.dataset.filename = v.filename || '';
          node.dataset.caption = v.caption || '';
          const img = document.createElement('img');
          img.alt = v.caption || v.filename || 'Captura';
          const cap = document.createElement('figcaption');
          cap.textContent = v.caption ? `📸 ${v.caption}` : `📸 ${v.filename || ''}`;
          node.appendChild(img);
          node.appendChild(cap);
          renderCaptureNode(node);
          return node;
        }
        static value(node) {
          return { filename: node.dataset.filename || '', caption: node.dataset.caption || '' };
        }
      }
      CaptureBlot.blotName = 'eots-capture';
      CaptureBlot.tagName = 'figure';
      CaptureBlot.className = 'eots-capture';
      Quill.register(CaptureBlot, true);
    }
  } catch (err) {
    console.debug('Aviso al registrar formatos personalizados en Quill:', err);
  }

  App.quill = new Quill('#quill-editor', {
    theme: 'snow',
    modules: {
      toolbar: '#quill-toolbar',
    },
    placeholder: 'Comienza a escribir tu documento de investigación aquí…',
    scrollingContainer: '#editor-area',
  });

  // "Limpiar formato" (Tx) quita negritas, cursivas, títulos, etc., pero CONSERVA los
  // colores de procedencia: son metadatos de auditoría, no un estilo del estudiante.
  const toolbarModule = App.quill.getModule('toolbar');
  if (toolbarModule) toolbarModule.addHandler('clean', cleanFormatPreservingProvenance);

  // Evitar saltos de navegación (scroll al inicio del documento) al aplicar estilos o reenfocar el editor
  const editorArea = document.getElementById('editor-area');
  const qlEditor = App.quill.root;
  if (qlEditor && editorArea) {
    const origFocus = qlEditor.focus.bind(qlEditor);
    qlEditor.focus = function(options) {
      const prevScroll = editorArea.scrollTop;
      origFocus(options || { preventScroll: true });
      if (prevScroll > 0 && editorArea.scrollTop === 0) {
        editorArea.scrollTop = prevScroll;
      }
    };
  }

  // Preservar la posición exacta de scroll al interactuar con la barra de herramientas (ej. selector de títulos)
  const quillToolbar = document.getElementById('quill-toolbar');
  if (quillToolbar && editorArea) {
    let toolbarScrollSnapshot = 0;

    const captureScroll = () => {
      if (editorArea.scrollTop > 0) {
        toolbarScrollSnapshot = editorArea.scrollTop;
      }
    };

    ['pointerdown', 'mousedown', 'touchstart'].forEach(evt => {
      quillToolbar.addEventListener(evt, captureScroll, { capture: true, passive: true });
    });

    const restoreScroll = () => {
      if (toolbarScrollSnapshot > 0) {
        const target = toolbarScrollSnapshot;
        requestAnimationFrame(() => {
          if (editorArea.scrollTop === 0 && target > 0) {
            editorArea.scrollTop = target;
          }
        });
        setTimeout(() => {
          if (editorArea.scrollTop === 0 && target > 0) {
            editorArea.scrollTop = target;
          }
          toolbarScrollSnapshot = 0;
        }, 50);
      }
    };

    quillToolbar.addEventListener('click', restoreScroll, { capture: true });
    quillToolbar.addEventListener('change', restoreScroll, { capture: true });
  }

  // Telemetría: detectar texto tecleado vs pegado y medir el proceso de escritura
  App.quill.on('text-change', (delta, oldDelta, source) => {
    if (source !== 'user') return;
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');

    const currentWC  = docWordCount();
    const wordDiff   = Math.max(0, currentWC - App.session.previousWordCount);

    const refreshViews = () => {
      App.session.previousWordCount = currentWC;
      updateWordCount(currentWC);
      scheduleTelemetryUI();
      scheduleUpdateTOC();
      updatePageMetrics();
      updateCursorPosition();
      adjustAllTablesWrapping();
    };

    // Deshacer/Rehacer (Ctrl+Z / Ctrl+Y) e inserciones propias de la app (citas, índice,
    // bibliografía, capturas) NO son escritura manual ni pegado: solo se resincroniza el conteo.
    if (App.session.isUndoRedo || App.session.isSystemInsert) {
      refreshViews();
      return;
    }

    // Analizar el cambio: caracteres insertados/borrados y dónde ocurrió
    let inserted = 0, deleted = 0, firstIdx = null, idx = 0;
    const insertedRanges = [];
    let insertedText = '';
    for (const op of delta.ops || []) {
      if (typeof op.retain === 'number') { idx += op.retain; continue; }
      if (typeof op.insert === 'string') {
        if (firstIdx === null) firstIdx = idx;
        inserted += op.insert.length;
        insertedRanges.push([idx, op.insert.length]);
        insertedText += op.insert;
        idx += op.insert.length;
      } else if (op.insert !== undefined) {
        if (firstIdx === null) firstIdx = idx;
        idx += 1;
      } else if (typeof op.delete === 'number') {
        if (firstIdx === null) firstIdx = idx;
        deleted += op.delete;
      }
    }

    if (App.session.isPasting) {
      // El pegado ya fue registrado por handlePasteEvent (externo) o es una
      // reubicación interna (cortar/pegar dentro del propio documento).
    } else if (wordDiff >= 10) {
      // Inserción masiva sin evento "paste" (menú contextual de móviles, arrastrar y soltar,
      // pegado dentro de una tabla): se trata exactamente igual que un pegado.
      registerExternalInsertion({
        text: insertedText || '',
        words: wordDiff,
        ranges: insertedRanges,
        via: 'insercion',
      });
    } else {
      // Escritura manual genuina
      App.session.words_typed += wordDiff;
      const pr = App.session.process;
      pr.chars_typed += inserted;
      pr.chars_deleted += deleted;
      if (firstIdx !== null) {
        const docLen = App.quill.getLength();
        const last = App.session.lastEditIndex;
        if (last !== null && Math.abs(firstIdx - last) > 40 && firstIdx < docLen - 40) {
          pr.nonlinear_edits++; // volvió a una parte anterior del texto para revisarla
        }
        App.session.lastEditIndex = firstIdx + inserted;
      }

      // El texto tecleado a mano nunca debe heredar el color de procedencia del texto
      // vecino (pegado, notas, cita…). Quill hace que lo que se escribe justo después de
      // un tramo con formato herede ese formato; aquí se limpia.
      insertedRanges.forEach(([i, len]) => {
        const f = App.quill.getFormat(i, Math.max(1, len));
        if (len <= 3 && f && isProvenanceBackground(f.background)) {
          App.quill.formatText(i, len, 'background', false, 'silent');
        }
      });
    }

    // Hitos de palabras para gamificación
    const milestones = [100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 5000];
    for (const m of milestones) {
      if (currentWC >= m && !App.session.passedMilestones.has(m)) {
        App.session.passedMilestones.add(m);
        if (!App.session.isPasting && wordDiff < 10) {
          SoundFx.play('milestone_words');
          showToast(`🎯 ¡Hito alcanzado: ${m} palabras en tu documento!`, 'success');
        }
      }
    }

    refreshViews();
  });

  // Seguimiento de posición de cursor en tiempo real (Línea X de Pág. Y)
  App.quill.on('selection-change', () => {
    updateCursorPosition();
  });

  // Activar corrector ortográfico nativo del navegador en español y eventos biométricos
  const editorEl = document.querySelector('#quill-editor .ql-editor');
  const editorWrap = document.getElementById('quill-editor');
  if (editorEl) {
    editorEl.setAttribute('spellcheck', 'true');
    editorEl.setAttribute('lang', 'es');
    editorEl.setAttribute('autocorrect', 'on');
    editorEl.addEventListener('paste', handlePasteEvent);
    editorEl.addEventListener('copy', (e) => handleCopyCut(e, false));
    editorEl.addEventListener('cut', (e) => handleCopyCut(e, true));
    editorEl.addEventListener('keydown', handleKeystrokeEvent);
    editorEl.addEventListener('keyup', (e) => {
      handleKeyUpEvent(e);
      updateCursorPosition();
    });
    editorEl.addEventListener('input', (e) => {
      scheduleUpdateTOC();
      updatePageMetrics();
      updateCursorPosition();
      const table = e.target.closest && e.target.closest('.academic-table');
      if (table) {
        adjustTableWrapping(table);
        if (e.inputType && e.inputType.startsWith('insert') && e.inputType !== 'insertFromPaste' && e.data) {
          App.session.process.chars_typed += e.data.length;
        }
        if (e.inputType && e.inputType.startsWith('delete')) App.session.process.chars_deleted += 1;
        App.ui.isDirty = true;
        updateSaveStatus('unsaved');
      }
    });
    editorEl.addEventListener('click', (e) => {
      handleTableActionClick(e);
      handleCaptureClick(e);
      updateCursorPosition();
    });
  }

  // Celdas de tabla: el editor (Quill) no debe interceptar las teclas ni el pegado que
  // ocurren DENTRO de una celda (antes Retroceso podía borrar la tabla completa y el
  // pegado se insertaba fuera de la tabla). Se usa la fase de captura del contenedor.
  if (editorWrap) {
    const inCell = (t) => t && t.closest && t.closest('.academic-table td, .academic-table th');
    editorWrap.addEventListener('keydown', (e) => {
      if (!inCell(e.target)) return;
      handleKeystrokeEvent(e);   // telemetría y biometría igualmente
      e.stopPropagation();       // Quill no procesa la tecla; el navegador edita la celda
    }, true);
    editorWrap.addEventListener('paste', (e) => {
      if (!inCell(e.target)) return;
      e.stopPropagation();
      e.preventDefault();
      const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      if (!text) return;
      App.session.isPasting = true;
      document.execCommand('insertText', false, text);
      setTimeout(() => { App.session.isPasting = false; }, 150);
      // El texto queda dentro de la tabla: se registra el pegado (no se puede colorear la celda)
      registerExternalInsertion({ text, words: countWords(text), ranges: [], via: 'tabla' });
    }, true);
  }
}

/* ================================================================
   TELEMETRÍA
   ================================================================ */

/** Recorre un Delta de Quill y llama a cb(index, length, attributes) por cada texto insertado. */
function forEachInsertedRange(delta, cb) {
  let idx = 0;
  for (const op of (delta && delta.ops) || []) {
    if (typeof op.retain === 'number') {
      idx += op.retain;
    } else if (op.insert !== undefined) {
      const len = typeof op.insert === 'string' ? op.insert.length : 1;
      if (typeof op.insert === 'string') cb(idx, len, op.attributes || null);
      idx += len;
    }
    // op.delete no avanza el índice en el documento resultante
  }
}

/** Ejecuta fn() marcando el cambio como inserción del sistema (no cuenta como tecleo ni pegado). */
function runAsSystemInsert(fn) {
  App.session.isSystemInsert = true;
  try { return fn(); }
  finally { App.session.isSystemInsert = false; }
}

/**
 * Marca Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (y "Deshacer" del menú del navegador) para que
 * text-change no confunda el texto restaurado con un pegado. Se usa la fase de captura
 * en document porque el atajo de Quill se ejecuta en el keydown del propio editor.
 */
function initUndoRedoGuard() {
  const mark = () => {
    App.session.isUndoRedo = true;
    setTimeout(() => { App.session.isUndoRedo = false; }, 0);
  };
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'z' || k === 'y') mark();
  }, true);
  document.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') mark();
  }, true);
}

/* ----------------------------------------------------------------
   COPIAR / CORTAR / PEGAR
   ---------------------------------------------------------------- */

/** Marca persistente de este dispositivo para reconocer copias hechas DENTRO del editor. */
function clipboardToken() {
  try {
    let t = localStorage.getItem('eots-clip-token');
    if (!t) { t = 'eotsclip_' + Math.random().toString(36).slice(2, 12); localStorage.setItem('eots-clip-token', t); }
    return t;
  } catch (_) { return App.session.clipboardToken; }
}

/**
 * Copiar/cortar dentro del documento: se etiqueta el portapapeles para que, al pegarlo
 * de nuevo aquí, se reconozca como REUBICACIÓN de texto propio (conserva su color de
 * procedencia original y no cuenta como pegado externo).
 */
function handleCopyCut(e, isCut) {
  if (!App.quill || !e.clipboardData) return;
  const sel = App.quill.getSelection();
  if (!sel || sel.length === 0) return;
  const domSel = window.getSelection();
  if (!domSel || domSel.rangeCount === 0) return;
  const holder = document.createElement('div');
  holder.appendChild(domSel.getRangeAt(0).cloneContents());
  holder.querySelectorAll('.academic-table-controls').forEach(n => n.remove());
  const token = clipboardToken();
  const text = App.quill.getText(sel.index, sel.length);
  try {
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', `<span data-eots-clip="${token}"></span>${holder.innerHTML}`);
    e.clipboardData.setData('application/x-eots-clip', token);
    e.preventDefault();
    if (isCut) App.quill.deleteText(sel.index, sel.length, 'user');
  } catch (_) { /* si el navegador no permite escribir el portapapeles, se usa el comportamiento normal */ }
}

function isInternalClipboard(cd) {
  if (!cd) return false;
  const token = clipboardToken();
  try {
    if ((cd.types || []).includes('application/x-eots-clip') && cd.getData('application/x-eots-clip') === token) return true;
  } catch (_) {}
  const html = cd.getData('text/html') || '';
  return html.includes(`data-eots-clip="${token}"`);
}

function handlePasteEvent(e) {
  const cd = e.clipboardData;
  const clipText = cd ? cd.getData('text/plain') : '';

  // Reubicación de texto propio (cortar/pegar dentro del documento): no es pegado externo
  if (isInternalClipboard(cd)) {
    App.session.isPasting = true;
    setTimeout(() => { App.session.isPasting = false; }, 150);
    return;
  }
  if (!clipText || clipText.trim().length === 0) return;

  const range = App.quill ? App.quill.getSelection() : null;
  const pasteIndex = (range && typeof range.index === 'number') ? range.index : 0;
  const replacedLen = (range && typeof range.length === 'number') ? range.length : 0;
  const lenBefore = App.quill ? App.quill.getLength() : 0;

  // Que text-change no cuente estas palabras como tecleadas
  App.session.isPasting = true;
  setTimeout(() => {
    App.session.isPasting = false;
    if (!App.quill) return;
    // Longitud realmente insertada = crecimiento del documento + lo que reemplazó la selección.
    // (No se usa clipText.length: en Windows el portapapeles trae \r\n y Quill lo normaliza a \n.)
    const currentLen = App.quill.getLength();
    const safeIndex = Math.min(Math.max(0, pasteIndex), currentLen - 1);
    const insertedChars = Math.max(0, Math.min(currentLen - lenBefore + replacedLen, currentLen - safeIndex - 1));
    registerExternalInsertion({
      text: clipText,
      words: countWords(clipText),
      ranges: insertedChars > 0 ? [[safeIndex, insertedChars]] : [],
      via: 'pegado',
    });
  }, 120);
}

/**
 * Registra un texto que NO se tecleó (pegado, arrastre, menú contextual del móvil…).
 * Se marca en rojo como "pegado sin declarar" y, si es grande, se pide al estudiante
 * que lo declare (notas propias, cita textual, IA). Lo declarado cambia de color y no
 * se penaliza, pero el docente lo ve.
 */
function registerExternalInsertion({ text, words, ranges, via }) {
  const clean = (text || '').replace(/\r\n/g, '\n');
  const chars = clean.replace(/\s+/g, '').length;
  if (chars === 0) return;
  const ev = {
    id:           'pst_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp:    new Date().toISOString(),
    chars_pasted: chars,
    approx_words: words || countWords(clean),
    kind:         'paste',
    declared:     false,
    via,
    excerpt:      clean.trim().slice(0, 160),
    source_id:    null,
    is_initial:   false,
  };
  App.session.paste_events.push(ev);
  (ranges || []).forEach(([i, len]) => App.quill.formatText(i, len, 'background', PROVENANCE_BG.paste, 'silent'));

  if (ev.approx_words >= EOTS.POLICY.PASTE_DECLARE_MIN_WORDS) {
    queuePasteDeclaration(ev, ranges || []);
  } else {
    SoundFx.play('paste_alert');
  }
  App.ui.isDirty = true;
  scheduleTelemetryUI();
}

/* ---- Declaración de pegados ---- */
const PasteDeclare = { queue: [], current: null };

function queuePasteDeclaration(ev, ranges) {
  PasteDeclare.queue.push({ ev, ranges });
  if (!PasteDeclare.current) showNextPasteDeclaration();
}

function showNextPasteDeclaration() {
  PasteDeclare.current = PasteDeclare.queue.shift() || null;
  if (!PasteDeclare.current) return;
  const { ev } = PasteDeclare.current;
  const ex = document.getElementById('paste-declare-excerpt');
  const wd = document.getElementById('paste-declare-words');
  if (ex) ex.textContent = ev.excerpt + (ev.excerpt.length >= 160 ? '…' : '');
  if (wd) wd.textContent = `${ev.approx_words} palabras`;
  const sel = document.getElementById('paste-quote-source');
  if (sel) {
    sel.innerHTML = '<option value="">— Elige la fuente citada —</option>' +
      (App.project.sources || []).map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml((s.authors?.[0] || 'Anón.').split(',')[0])} (${escapeHtml(String(s.year || 's. f.'))}) — ${escapeHtml((s.title || '').slice(0, 60))}</option>`).join('');
  }
  // Sugerencia: si el documento está casi vacío, lo más probable son notas propias
  const docWords = docWordCount();
  const suggested = docWords - ev.approx_words < 60 ? 'notes' : '';
  document.querySelectorAll('input[name="paste-kind"]').forEach(r => { r.checked = (r.value === suggested); });
  updatePasteDeclareForm();
  openModal('modal-paste-overlay');
}

function updatePasteDeclareForm() {
  const kind = document.querySelector('input[name="paste-kind"]:checked')?.value || '';
  const row = document.getElementById('paste-quote-row');
  if (row) row.style.display = kind === 'quote' ? 'block' : 'none';
}

function resolvePasteDeclaration(declare) {
  const item = PasteDeclare.current;
  closeModal('modal-paste-overlay');
  if (!item) return;
  const { ev, ranges } = item;
  let kind = declare ? (document.querySelector('input[name="paste-kind"]:checked')?.value || '') : '';
  if (kind === 'quote') {
    const srcId = document.getElementById('paste-quote-source')?.value || '';
    if (!srcId) {
      showToast('Para declarar una cita textual elige la fuente de la que proviene.', 'warning');
      PasteDeclare.queue.unshift(item);
      PasteDeclare.current = null;
      setTimeout(showNextPasteDeclaration, 50);
      return;
    }
    ev.source_id = srcId;
    const src = App.project.sources.find(s => s.id === srcId);
    if (src) { src.quoted_in_text = true; src.cited_in_text = true; }
  }
  if (['notes', 'quote', 'ai'].includes(kind)) {
    ev.kind = kind;
    ev.declared = true;
    ev.declared_at = new Date().toISOString();
    ranges.forEach(([i, len]) => {
      if (i + len <= App.quill.getLength()) App.quill.formatText(i, len, 'background', PROVENANCE_BG[kind], 'silent');
    });
    showToast(`Pegado declarado como: ${EOTS.PROVENANCE[kind].label}.`, 'info');
  } else {
    ev.kind = 'paste';
    ev.declared = false;
    SoundFx.play('paste_alert');
    showToast('Pegado registrado SIN declarar (se reporta al docente).', 'warning');
  }
  App.ui.isDirty = true;
  renderSourcesList();
  scheduleTelemetryUI();
  PasteDeclare.current = null;
  if (PasteDeclare.queue.length) setTimeout(showNextPasteDeclaration, 200);
}

/* ---- Limpiar formato conservando la procedencia ---- */
function cleanFormatPreservingProvenance(range) {
  const quill = App.quill;
  range = range || quill.getSelection();
  if (!range) return;
  if (range.length === 0) {
    // Cursor sin selección: quitar formatos de escritura activos, excepto el fondo
    const formats = quill.getFormat();
    Object.keys(formats).forEach(name => {
      if (name === 'background') return;
      const Parchment = Quill.import('parchment');
      if (Parchment.query(name, Parchment.Scope.INLINE) != null) quill.format(name, false, 'user');
    });
    return;
  }
  // Guardar los tramos con color de procedencia, limpiar y volver a aplicarlos
  const keep = [];
  let off = 0;
  (quill.getContents(range.index, range.length).ops || []).forEach(op => {
    const len = typeof op.insert === 'string' ? op.insert.length : 1;
    const bg = op.attributes && op.attributes.background;
    if (bg && isProvenanceBackground(bg)) keep.push([range.index + off, len, bg]);
    off += len;
  });
  runAsSystemInsert(() => {
    quill.removeFormat(range.index, range.length, 'user');
    keep.forEach(([i, len, bg]) => quill.formatText(i, len, 'background', bg, 'user'));
  });
  quill.setSelection(range.index, range.length, 'silent');
}

/* ---- Teclado: telemetría de proceso + biometría ---- */
function handleKeystrokeEvent(e) {
  // Los atajos (Ctrl+Z, Ctrl+V, Ctrl+S, Ctrl+B…) no son escritura: no cuentan como
  // pulsaciones ni alimentan la huella biométrica.
  if (e.ctrlKey || e.metaKey) return;
  const ignore = ['Control','Alt','Shift','Meta','CapsLock','Tab','Escape',
    'ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown',
    'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'];
  if (!ignore.includes(e.key)) {
    App.session.keystroke_count++;
  }

  // Ritmo y pausas (proceso de composición)
  const pr = App.session.process;
  const now = performance.now();
  if (App.session.lastKeyTime) {
    const gap = now - App.session.lastKeyTime;
    if (gap < 30000) pr.active_ms += gap;
    if (gap >= 2000 && gap < 30000) pr.pauses_2s++;
  }
  App.session.lastKeyTime = now;
  if (e.key === 'Backspace' || e.key === 'Delete') pr.backspaces++;
  else if (e.key && (e.key.length === 1 || e.key === 'Enter' || e.key === 'Unidentified' || e.key === 'Process')) pr.text_keys++;

  BiometricsEngine.onKeyDown(e);
}

function handleKeyUpEvent(e) {
  BiometricsEngine.onKeyUp(e);
}

function initSessionTimer() {
  if (App.session.timer_ref) {
    clearInterval(App.session.timer_ref);
    App.session.timer_ref = null;
  }
  if (!App.session.start_time) App.session.start_time = new Date();
  App.session.timer_ref = setInterval(() => {
    if (!App.session.start_time) return;
    const elapsed = Math.floor((Date.now() - App.session.start_time.getTime()) / 1000);
    const hh = Math.floor(elapsed / 3600);
    const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    const txt = hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
    const teleTimerEl = document.getElementById('tele-session-time');
    const sbTimerEl   = document.getElementById('sb-session-time');
    if (teleTimerEl) teleTimerEl.textContent = txt;
    if (sbTimerEl)   sbTimerEl.textContent   = `Sesión: ${txt}`;
  }, 1000);
}

/* ----------------------------------------------------------------
   CONTEO DE PALABRAS (incluye el texto de las tablas)
   ---------------------------------------------------------------- */
function tablesText() {
  return Array.from(document.querySelectorAll('#quill-editor .academic-table td, #quill-editor .academic-table th'))
    .map(c => c.textContent || '').join(' ');
}
function docWordCount() {
  if (!App.quill) return 0;
  return countWords(App.quill.getText()) + countWords(tablesText());
}

/* ----------------------------------------------------------------
   REGISTRO DE LA SESIÓN ACTUAL (lo usan el guardado y el panel)
   ---------------------------------------------------------------- */
function buildCurrentSessionRecord() {
  const now = new Date();
  const startTime = App.session.start_time || now;
  const currentWC = docWordCount();
  const bm = App.session.biometrics.metrics;
  const nonInitialChars = (App.session.paste_events || [])
    .filter(ev => EOTS.pasteKind(ev) === 'paste')
    .reduce((sum, ev) => sum + (ev.chars_pasted || 0), 0);
  return {
    session_id:         App.session.id,
    session_number:     App.session.session_number,
    date:               startTime.toISOString().split('T')[0],
    start_time:         startTime.toISOString(),
    end_time:           now.toISOString(),
    duration_minutes:   Math.max(1, Math.round((now.getTime() - startTime.getTime()) / 60000)),
    active_minutes:     Math.round((App.session.process.active_ms || 0) / 60000),
    device:             App.device ? { ...App.device } : null,
    app_version:        APP_VERSION,
    initial_word_count: App.session.initial_word_count || 0,
    final_word_count:   currentWC,
    words_net_change:   currentWC - (App.session.initial_word_count || 0),
    words_typed:        App.session.words_typed,
    chars_pasted:       nonInitialChars,             // solo pegados SIN declarar
    paste_events:       [...App.session.paste_events],
    keystroke_count:    App.session.keystroke_count,
    process:            { ...App.session.process },
    timeline:           App.session.timeline.slice(-1500),
    biometrics: (BiometricsEngine.applies() && bm && bm.samples >= EOTS.POLICY.BIO_MIN_SAMPLES) ? {
      device_class:     'keyboard',
      samples:          bm.samples,
      mean_dwell_ms:    bm.mean_dwell_ms,
      mean_flight_ms:   bm.mean_flight_ms,
      similarity_score: bm.similarity_score,
      is_consistent:    bm.similarity_score >= EOTS.POLICY.BIO_OK,
    } : {
      device_class:     App.device?.class || 'keyboard',
      samples:          App.session.biometrics.samples.length,
      similarity_score: null,
      not_applicable:   !BiometricsEngine.applies(),
    },
  };
}

/** Copia del proyecto con el contenido y la sesión actuales (para calcular métricas en vivo). */
function projectSnapshotForAnalytics() {
  const p = { ...App.project };
  p.content = { delta: App.quill ? App.quill.getContents() : App.project.content.delta, html: '' };
  const sessions = (App.project.telemetry?.sessions || []).slice();
  if (App.session.id) {
    const rec = buildCurrentSessionRecord();
    const i = sessions.findIndex(s => s.session_id === rec.session_id);
    if (i >= 0) sessions[i] = rec; else sessions.push(rec);
  }
  p.telemetry = { ...(App.project.telemetry || {}), sessions };
  return p;
}

/* ----------------------------------------------------------------
   PANEL "ACTIVIDAD Y SALUD" — ACUMULADO DE TODAS LAS SESIONES
   Y DISPOSITIVOS (mismas reglas que el panel docente: analytics.js)
   ---------------------------------------------------------------- */
const PROV_BAR_COLORS = {
  typed: 'rgba(16,185,129,0.85)', notes: 'rgba(74,108,247,0.75)', quote: 'rgba(20,184,166,0.75)',
  ai: 'rgba(245,158,11,0.85)', paste: 'rgba(229,57,53,0.80)',
};
let teleTimer = null;
function scheduleTelemetryUI() {
  clearTimeout(teleTimer);
  teleTimer = setTimeout(updateTelemetryUI, 500);
}

function updateTelemetryUI() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  // ---- Sesión actual ----
  set('tele-words-typed', App.session.words_typed);
  set('tele-paste-count', App.session.paste_events.length);
  set('tele-device-label', App.device?.label || '—');

  // Si el panel está cerrado no se recalcula todo (se hace al abrirlo)
  const panel = document.getElementById('sidebar-telemetry');
  if (panel && panel.classList.contains('collapsed') && !App.ui.forceTelemetry) return;

  const m = EOTS.computeMetrics(projectSnapshotForAnalytics());
  const alerts = EOTS.computeAlerts(m);
  App.ui.lastMetrics = m;

  // ---- Salud: % del texto final tecleado ----
  const ratio = Math.round((m.typed_share || 0) * 100);
  const fill = document.getElementById('health-fill');
  if (fill) {
    fill.style.width = `${ratio}%`;
    fill.classList.remove('medium', 'low');
    if (m.typed_share < EOTS.POLICY.TYPED_DANGER) fill.classList.add('low');
    else if (m.typed_share < EOTS.POLICY.TYPED_WARN) fill.classList.add('medium');
  }
  set('health-percent', m.word_count === 0 ? '—' : `${ratio}%`);

  // ---- Desglose de procedencia ----
  const bar = document.getElementById('prov-bar');
  const legend = document.getElementById('prov-legend');
  if (bar && legend) {
    const sh = m.provenance?.shares;
    const kinds = ['typed', 'notes', 'quote', 'ai', 'paste'];
    if (sh && m.provenance.body > 0) {
      bar.innerHTML = kinds.filter(k => sh[k] > 0).map(k =>
        `<span title="${EOTS.PROVENANCE[k].label}: ${EOTS.pct(sh[k])}" style="width:${(sh[k] * 100).toFixed(2)}%;background:${PROV_BAR_COLORS[k]}"></span>`).join('');
      legend.innerHTML = kinds.map(k => `<div class="tele-stat"><span class="text-sm text-muted">${EOTS.PROVENANCE[k].label}</span><span class="tele-stat-value">${EOTS.pct(sh[k])}</span></div>`).join('');
    } else {
      bar.innerHTML = '';
      legend.innerHTML = '<p class="text-sm text-muted">Aún no hay texto en el documento.</p>';
    }
  }

  // ---- Totales del proyecto (todas las sesiones, todos los dispositivos) ----
  // Con registro del curso se usan las cifras del servidor: incluyen las sesiones de TODOS
  // los dispositivos aunque el paquete no se haya llevado de uno a otro.
  const server = (window.Cloud && Cloud.enabled && Cloud.isLoggedIn() && Cloud.estado && Cloud.estado.metrics) ? Cloud.estado : null;
  const sm = server ? server.metrics : null;
  const tot = sm && sm.total_sessions >= m.total_sessions ? sm : m;
  set('tele-totals-source', server
    ? `Según el registro del curso · actualizado ${new Date(server.updated).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`
    : 'Calculado en este dispositivo');
  set('tele-total-sessions', tot.total_sessions);
  set('tele-days-active', tot.total_days_active);
  set('tele-devices', tot.devices.length ? tot.devices.map(d => d.label).join(', ') : '—');
  set('tele-total-typed', tot.total_words_typed.toLocaleString('es'));
  const declared = tot.pastes.notes.n + tot.pastes.quote.n + tot.pastes.ai.n;
  set('tele-pastes-declared', declared);
  set('tele-pastes-undeclared', tot.pastes.paste.n);
  set('tele-sources-with-img', `${m.sources_with_screenshot}/${m.sources_count}`);
  set('tele-revision', tot.process.revision_ratio === null ? '—' : EOTS.pct(tot.process.revision_ratio));

  // ---- Lo que verá el docente ----
  const al = document.getElementById('tele-alerts');
  if (al) {
    // Las alertas del servidor consideran todos los dispositivos; si aún no hay, las locales
    const source = server && server.alerts ? server.alerts : alerts;
    const visible = source.filter(a => a.level !== 'info' || ['ai_present', 'bio_none', 'other_projects'].includes(a.code));
    al.innerHTML = visible.length
      ? visible.map(a => `<div class="tele-alert tele-alert-${a.level}">${a.level === 'danger' ? '⚠' : a.level === 'warning' ? '!' : 'ℹ'} ${escapeHtml(a.message)}</div>`).join('')
      : '<div class="tele-alert tele-alert-ok">✓ Sin observaciones por ahora.</div>';
  }
}

/* ================================================================
   GESTIÓN DEL PROYECTO (File System Access API y Almacenamiento Local)
   ================================================================ */

function updateFolderButtonUI() {
  const folderLabel = document.getElementById('open-folder-label');
  const folderBtn = document.getElementById('btn-open-folder');
  if (!folderLabel) return;

  if (App.dirHandle && App.dirHandle.name) {
    folderLabel.textContent = App.dirHandle.name;
    if (folderBtn) folderBtn.title = `Carpeta elegida: ${App.dirHandle.name} (Haz clic para cambiar)`;
  } else {
    const lastFolder = localStorage.getItem('eots-last-folder-name');
    if (lastFolder && 'showDirectoryPicker' in window) {
      folderLabel.textContent = lastFolder;
      if (folderBtn) folderBtn.title = `Carpeta elegida: ${lastFolder} (Haz clic para volver a vincular)`;
    } else if ('showDirectoryPicker' in window) {
      folderLabel.textContent = 'Abrir / Crear carpeta';
      if (folderBtn) folderBtn.title = 'Seleccionar carpeta de trabajo para autoguardado';
    } else {
      folderLabel.textContent = 'Guardado local';
      if (folderBtn) folderBtn.title = 'Autoguardado en almacenamiento local del dispositivo';
    }
  }
}

function adaptUIForPlatform() {
  const hasFSA = 'showDirectoryPicker' in window;
  const onboardOpen = document.getElementById('onboard-open');
  const onboardNewText = document.getElementById('onboard-new-text');
  const mobileNotice = document.getElementById('onboard-mobile-notice');

  if (!hasFSA) {
    if (onboardNewText) onboardNewText.textContent = 'Crear nuevo documento';
    if (onboardOpen) onboardOpen.style.display = 'none';
    if (mobileNotice) mobileNotice.style.display = 'block';
  } else {
    if (onboardNewText) onboardNewText.textContent = 'Crear nuevo documento (en carpeta)';
    if (onboardOpen) onboardOpen.style.display = 'flex';
  }
  updateFolderButtonUI();

  // En pantallas móviles / tablets estrechas, colapsar paneles laterales al inicio para maximizar el área de escritura
  if (window.innerWidth <= 768) {
    App.ui.sourcesPanelOpen = false;
    App.ui.telePanelOpen = false;
    const sbSources = document.getElementById('sidebar-sources');
    const sbTele = document.getElementById('sidebar-telemetry');
    if (sbSources) sbSources.classList.add('collapsed');
    if (sbTele) sbTele.classList.add('collapsed');
  }
}

async function openOrCreateProject(mode) {
  const hasFSA = 'showDirectoryPicker' in window;

  if (!hasFSA) {
    if (mode === 'new') {
      // En iPhone, Android, Safari, etc. crear directamente sin bloquear con errores
      await createNewProjectDirectly();
      return;
    } else {
      // Si quería abrir pero no soporta carpetas, disparar selector de .json
      showToast('En dispositivos móviles, selecciona tu archivo .json directamente.', 'info');
      openJsonFileDialog();
      return;
    }
  }

  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    App.dirHandle = dirHandle;
    App.jsonFileHandle = null; // a partir de ahora se guarda en la carpeta
    App.folderName = dirHandle.name;
    localStorage.setItem('eots-last-folder-name', dirHandle.name);

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

    // Actualizar nombre del proyecto en statusbar (si existe) y métricas de página
    const sbProj = document.getElementById('sb-project-name');
    if (sbProj) sbProj.textContent = dirHandle.name;
    updatePageMetrics();
    updateFolderButtonUI();

    // Iniciar autoguardado (cada 15 segundos)
    startAutosave();

  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Error al abrir carpeta:', err);
      if (mode === 'new') {
        await createNewProjectDirectly();
      } else {
        showToast('No se pudo abrir la carpeta. ' + err.message, 'error');
      }
    }
  }
}

/** Deja el editor y el estado en blanco para un documento nuevo (sin arrastrar datos del anterior). */
function resetToBlankProject() {
  App.project = freshProjectTemplate();
  App.project.metadata.title = 'Sin título';
  const titleInput = document.getElementById('doc-title-input');
  if (titleInput) titleInput.value = '';
  if (App.quill) App.quill.setText('', 'silent');
  renderSourcesList();
  updateTableOfContents();
  updateWordCount(0);
}

async function createNewProjectDirectly() {
  if (window.Cloud && !Cloud.confirmNewDocument()) return;
  resetSessionTimers();
  App.dirHandle = null;
  App.capturasHandle = null;
  App.jsonFileHandle = null;
  App.jsonFileName = 'documento.json';

  resetToBlankProject();

  startProjectSession();
  await saveProject();

  closeModal('modal-onboarding-overlay');
  App.ui.projectLoaded = true;

  const sbName = document.getElementById('sb-project-name');
  if (sbName) sbName.textContent = 'Documento nuevo (Local)';
  updateFolderButtonUI();

  startAutosave();
  SoundFx.play('session_start');
  showToast('✓ Documento listo. Tu trabajo se guarda continuamente en este dispositivo.', 'success');
  promptAuthorIfMissing();
}

function resetSessionTimers() {
  if (App.session.timer_ref) {
    clearInterval(App.session.timer_ref);
    App.session.timer_ref = null;
  }
  if (App.session.autosave_ref) {
    clearInterval(App.session.autosave_ref);
    App.session.autosave_ref = null;
  }
}

function startProjectSession() {
  const currentWC = docWordCount();

  // Asegurar estructura de telemetría en el proyecto
  if (!App.project.telemetry) App.project.telemetry = { sessions: [], summary: {} };
  if (!Array.isArray(App.project.telemetry.sessions)) App.project.telemetry.sessions = [];

  const sessions = App.project.telemetry.sessions;
  const last = sessions[sessions.length - 1];
  const now = new Date();

  // Recargar la página (o que el celular suspenda la pestaña) dentro de 30 minutos en el
  // MISMO dispositivo continúa la misma sesión en lugar de inflar el conteo de sesiones.
  const canResume = !!(last && App.device && last.device?.id === App.device.id && last.end_time &&
    (now.getTime() - Date.parse(last.end_time)) < EOTS.POLICY.SESSION_RESUME_MINUTES * 60000);

  if (canResume) {
    App.session.id = last.session_id;
    App.session.session_number = last.session_number || sessions.length;
    App.session.start_time = new Date(last.start_time || now);
    App.session.words_typed = last.words_typed || 0;
    App.session.paste_events = [...(last.paste_events || [])];
    App.session.keystroke_count = last.keystroke_count || 0;
    App.session.initial_word_count = (typeof last.initial_word_count === 'number') ? last.initial_word_count : currentWC;
    App.session.process = { ...freshProcessStats(), ...(last.process || {}) };
    App.session.timeline = [...(last.timeline || [])];
    App.session.resumed = true;
  } else {
    App.session.id = 'ses_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    App.session.session_number = sessions.length + 1;
    App.session.start_time = now;
    App.session.words_typed = 0;
    App.session.paste_events = [];
    App.session.keystroke_count = 0;
    App.session.initial_word_count = currentWC;
    App.session.process = freshProcessStats();
    App.session.timeline = [];
    App.session.resumed = false;
  }
  App.session.chars_pasted = 0;
  App.session.previousWordCount = currentWC;
  App.session.lastKeyTime = 0;
  App.session.lastEditIndex = null;
  // Los hitos ya superados por el documento existente no deben "celebrarse" de golpe
  App.session.passedMilestones = new Set(
    [100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 5000].filter(m => m <= currentWC)
  );

  // Biometría: siempre se mide de cero en cada sesión (no se arrastran métricas)
  App.session.biometrics = {
    activeKeyDowns:   new Map(),
    lastKeyUpTime:    0,
    samples:          [],
    spaceDwells:      [],
    backspaceDwells:  [],
    notifiedBaseline: !!BiometricsEngine.baseline(),
    metrics:          null,
  };

  initSessionTimer();
  App.ui.forceTelemetry = true;
  updateTelemetryUI();
  App.ui.forceTelemetry = false;
  BiometricsEngine.updateUI();
  return canResume;
}

async function createNewProject(dirHandle) {
  if (window.Cloud && !Cloud.confirmNewDocument()) return;
  resetSessionTimers();
  App.jsonFileName = 'documento.json';
  resetToBlankProject();

  startProjectSession();
  await saveProject();
  SoundFx.play('session_start');
  showToast('Proyecto creado. El autoguardado está activo.', 'success');
  promptAuthorIfMissing();
}

/** Lee un .zip de proyecto y devuelve { parsed, name } sin cargarlo. */
async function readBundle(fileOrBlob) {
  if (!window.JSZip) throw new Error('No se pudo cargar el lector de paquetes .zip (revisa tu conexión la primera vez).');
  const zip = await JSZip.loadAsync(fileOrBlob);
  let entry = zip.file('proyecto.json');
  if (!entry) entry = zip.file(/^[^/]+\.json$/i)[0] || zip.file(/\.json$/i).find(f => !f.name.startsWith('capturas/'));
  if (!entry) throw new Error('El paquete no contiene el archivo proyecto.json.');
  const parsed = JSON.parse(await entry.async('string'));
  return { zip, parsed };
}

/** Restaura en el almacén portable las capturas que vienen en un paquete .zip. */
async function importBundleCaptures(zip, parsed) {
  const project = migrateProject(safeClone(parsed));
  const pid = project.metadata.project_id;
  const registry = project.captures || {};
  const result = { restored: 0, mismatch: 0, extra: 0 };
  const files = zip.file(/^capturas\/[^/]+$/i);
  for (const f of files) {
    const filename = f.name.split('/').pop();
    const raw = await f.async('blob');
    const blob = new Blob([raw], { type: mimeFromName(filename) });
    const entry = registry[filename];
    if (entry && entry.sha256) {
      const sha = await CaptureStore.sha256Hex(blob);
      if (sha !== entry.sha256) result.mismatch++;
    } else if (!entry) {
      result.extra++;
    }
    await CaptureStore.put(pid, filename, blob);
    result.restored++;
  }
  return result;
}

function mimeFromName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'application/octet-stream';
}

async function loadExistingProject(dirHandle) {
  resetSessionTimers();
  // Buscar TODOS los .json (y paquetes .zip) de la carpeta y abrir el más reciente según
  // metadata.last_saved. Así una copia más nueva traída desde el celular no se ignora.
  const candidates = [];
  if ('values' in dirHandle) {
    for await (const entry of dirHandle.values()) {
      if (entry.kind !== 'file') continue;
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith('.json') && !lower.endsWith('.zip')) continue;
      try {
        const f = await entry.getFile();
        let parsed, zip = null;
        if (lower.endsWith('.zip')) ({ parsed, zip } = await readBundle(f));
        else parsed = JSON.parse(await f.text());
        if (!parsed || typeof parsed !== 'object' || !(parsed.content || parsed.metadata)) continue;
        const stamp = Date.parse(parsed.metadata?.last_saved || '') || f.lastModified || 0;
        candidates.push({ name: entry.name, parsed, zip, stamp });
      } catch (_) { /* no es un proyecto válido */ }
    }
  }

  if (candidates.length === 0) {
    if (App.ui.projectLoaded) {
      // Carpeta vacía y ya hay un documento abierto → vincularlo (no borrarlo)
      App.jsonFileName = 'documento.json';
      App.jsonFileHandle = null;
      await syncFolderCaptures();
      await saveProject();
      showToast(`Carpeta "${dirHandle.name}" vinculada: el documento y sus capturas se guardaron en ella.`, 'success');
      return;
    }
    await createNewProject(dirHandle);
    return;
  }

  candidates.sort((a, b) => b.stamp - a.stamp);
  const chosen = candidates[0];
  if (candidates.length > 1) {
    showToast(`Hay ${candidates.length} archivos de proyecto en la carpeta; se abrió el más reciente: "${chosen.name}".`, 'info');
  }

  if (chosen.zip) {
    // El más reciente es un paquete (p. ej. traído del celular): restaurar sus capturas y
    // seguir guardando en el .json del mismo proyecto que haya en la carpeta.
    const res = await importBundleCaptures(chosen.zip, chosen.parsed);
    const pid = migrateProject(safeClone(chosen.parsed)).metadata.project_id;
    const sameJson = candidates.find(c => !c.zip && migrateProject(safeClone(c.parsed)).metadata.project_id === pid);
    App.jsonFileName = sameJson ? sameJson.name : 'documento.json';
    if (res.restored) showToast(`${res.restored} captura(s) restaurada(s) desde "${chosen.name}".`, 'info');
  } else {
    // Guardar de vuelta en el MISMO archivo que se abrió (no en otro documento.json)
    App.jsonFileName = chosen.name;
  }
  App.jsonFileHandle = null;
  await loadProjectFromParsedJSON(chosen.parsed, chosen.name, { keepFolder: true, fromFolder: true });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result || '');
      reader.onerror = (e) => {
        if (file && typeof file.text === 'function') file.text().then(resolve).catch(reject);
        else reject(e);
      };
      reader.readAsText(file);
    } catch (err) {
      if (file && typeof file.text === 'function') file.text().then(resolve).catch(reject);
      else reject(err);
    }
  });
}

/**
 * Normaliza proyectos de versiones anteriores al esquema 2:
 * identificador estable, registro de capturas, huella biométrica por tipo de dispositivo.
 */
function migrateProject(p) {
  if (!p.metadata) p.metadata = {};
  const md = p.metadata;
  if (!md.project_id) {
    // Id determinista: el mismo proyecto abierto en dos dispositivos obtiene el mismo id
    md.project_id = 'prj_legacy_' + String(md.created_at || md.title || 'sin_fecha').replace(/[^0-9A-Za-z]/g, '');
  }
  if (md.student_email === undefined) md.student_email = '';
  if (md.student_name === undefined) md.student_name = '';
  if (!p.captures || typeof p.captures !== 'object') p.captures = {};
  // Capturas insertadas en el texto con la versión anterior
  Object.entries(p.inline_screenshots || {}).forEach(([placeholder, info]) => {
    if (info && info.filename && !p.captures[info.filename]) {
      p.captures[info.filename] = {
        sha256: null, mime: info.mime_type || mimeFromName(info.filename), size: info.size || 0,
        created_at: info.inserted_at || null, source_id: null, caption: '', legacy: true,
      };
    }
  });
  // Capturas de evidencia de fuentes con la versión anterior
  (p.sources || []).forEach(src => {
    if (src.screenshot_filename && !p.captures[src.screenshot_filename]) {
      p.captures[src.screenshot_filename] = {
        sha256: null, mime: mimeFromName(src.screenshot_filename), size: 0,
        created_at: src.added_at || null, source_id: src.id, caption: src.title || '', legacy: true,
      };
    }
  });
  if (!p.biometrics) p.biometrics = {};
  if (!p.biometrics.baselines) p.biometrics.baselines = {};
  if (!p.biometrics.baselines.keyboard && p.biometrics.baseline) p.biometrics.baselines.keyboard = p.biometrics.baseline;
  delete p.has_initial_paste;
  return p;
}

/** Convierte los antiguos marcadores de texto "[📸 Captura: archivo]" en imágenes reales. */
function convertLegacyCapturePlaceholders() {
  if (!App.quill) return;
  const text = App.quill.getText();
  const re = /\[📸 Captura: ([^\]\n]+)\]/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) found.push({ index: m.index, length: m[0].length, filename: m[1].trim() });
  for (let i = found.length - 1; i >= 0; i--) {
    const f = found[i];
    App.quill.deleteText(f.index, f.length, 'silent');
    App.quill.insertEmbed(f.index, 'eots-capture', { filename: f.filename, caption: '' }, 'silent');
  }
}

async function loadProjectFromParsedJSON(parsed, sourceName = 'documento.json', opts = {}) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('El archivo no contiene un formato JSON válido.');
  }
  const incoming = migrateProject(safeClone(parsed));

  // Protección entre dispositivos (mismo proyecto abierto aquí y en el archivo elegido)
  if (!opts.silentRestore && App.ui.projectLoaded &&
      incoming.metadata.project_id === App.project.metadata?.project_id) {
    const fileIds = new Set((incoming.telemetry?.sessions || []).map(s => s.session_id));
    const hereIds = new Set((App.project.telemetry?.sessions || []).map(s => s.session_id));
    if (App.session.id) hereIds.add(App.session.id);
    const onlyHere = [...hereIds].filter(id => !fileIds.has(id));
    const onlyFile = [...fileIds].filter(id => !hereIds.has(id));
    const fileStamp = Date.parse(incoming.metadata?.last_saved || '') || 0;
    const hereStamp = Date.parse(App.project.metadata?.last_saved || '') || 0;
    const fmt = (t) => new Date(t).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });
    let question = null;
    if (onlyHere.length && onlyFile.length) {
      question = `ATENCIÓN: este dispositivo y el archivo "${sourceName}" tienen versiones que se SEPARARON ` +
        `(se trabajó en ambos sin llevar el archivo de uno a otro).\n\n` +
        `• ${onlyHere.length} sesión(es) existen solo en este dispositivo y se perderán.\n` +
        `• ${onlyFile.length} sesión(es) existen solo en el archivo.\n\n` +
        `¿Reemplazar la versión de este dispositivo por la del archivo?`;
    } else if (onlyHere.length && fileStamp && hereStamp && fileStamp < hereStamp) {
      question = `El archivo "${sourceName}" es una versión ANTERIOR de este proyecto.\n\n` +
        `• Archivo elegido: guardado ${fmt(fileStamp)}\n` +
        `• Versión abierta en este dispositivo: guardada ${fmt(hereStamp)}\n\n` +
        `¿Reemplazar la versión de este dispositivo por la del archivo?`;
    }
    if (question && !confirm(question)) {
      showToast('Se conservó la versión de este dispositivo.', 'info');
      return false;
    }
  }

  // Guardar el progreso de la sesión que se está cerrando antes de reemplazarla
  if (App.ui.projectLoaded && App.ui.isDirty && !opts.silentRestore) {
    try { await saveProject({ force: true }); } catch (_) {}
  }
  resetSessionTimers();

  // Destino de los guardados
  if (opts.fileHandle) {
    // .json o .zip abierto en PC con permiso de escritura: se guarda EN ESE MISMO ARCHIVO
    App.jsonFileHandle = opts.fileHandle;
    App.dirHandle = null;
    App.capturasHandle = null;
  } else if (opts.keepFolder) {
    App.jsonFileHandle = null;
  } else if (!opts.silentRestore) {
    // Archivo suelto sin permiso de escritura: desvincular la carpeta para no sobrescribir
    // el proyecto que ella contiene con otro distinto.
    if (App.dirHandle) showToast('Se desvinculó la carpeta anterior para no sobrescribir su proyecto.', 'info');
    App.jsonFileHandle = null;
    App.dirHandle = null;
    App.capturasHandle = null;
  }

  // Verificar firma de integridad si existe
  if (parsed._signature) {
    try {
      const valid = await verifySignature(parsed);
      if (!valid) showToast('⚠ El archivo JSON fue modificado externamente. Firma alterada.', 'warning');
    } catch (e) { console.debug('Error en validación de firma:', e); }
  }

  // Fusionar sobre una plantilla limpia (nada del proyecto anterior se hereda)
  App.project = migrateProject({ ...freshProjectTemplate(), ...incoming });
  delete App.project._signature;
  if (!parsed.metadata?.title) App.project.metadata.title = (sourceName || 'documento').replace(/\.(json|zip)$/i, '');
  if (!Array.isArray(App.project.sources)) App.project.sources = [];

  // Restaurar contenido en Quill de forma segura
  if (App.quill) {
    try {
      if (App.project.content && App.project.content.delta) {
        App.quill.setContents(App.project.content.delta, 'silent');
      } else if (App.project.content && App.project.content.html) {
        App.quill.clipboard.dangerouslyPasteHTML(App.project.content.html, 'silent');
      }
    } catch (quillErr) {
      console.warn('Error al cargar delta en Quill, usando HTML plano:', quillErr);
      if (App.project.content && App.project.content.html) {
        App.quill.clipboard.dangerouslyPasteHTML(App.project.content.html, 'silent');
      }
    }
    convertLegacyCapturePlaceholders();
  }

  const titleInput = document.getElementById('doc-title-input');
  if (titleInput) {
    titleInput.value = App.project.metadata.title || '';
    document.title = `${titleInput.value || 'Sin título'} — Eye on the Sky`;
  }
  syncAuthorInputs();

  renderSourcesList();
  updateTableOfContents();
  updatePageMetrics();
  setTimeout(() => adjustAllTablesWrapping(), 120);

  updateWordCount(docWordCount());
  const resumed = startProjectSession();

  App.ui.projectLoaded = true;

  const sbName = document.getElementById('sb-project-name');
  if (sbName) sbName.textContent = App.dirHandle ? App.dirHandle.name : sourceName;
  updateFolderButtonUI();

  if (App.dirHandle) await syncFolderCaptures();

  startAutosave();
  await saveProject({ force: true });
  closeModal('modal-onboarding-overlay');

  try { SoundFx.play('session_start'); } catch (e) {}

  if (!opts.silentRestore || !resumed) {
    if (App.jsonFileHandle) {
      showToast(`✓ Proyecto cargado. Los cambios se guardarán directamente en "${App.jsonFileHandle.name}".`, 'success');
    } else if (App.dirHandle) {
      showToast(`✓ Proyecto "${App.project.metadata.title || sourceName}" cargado desde la carpeta.`, 'success');
    } else if (!opts.silentRestore) {
      showToast(`✓ Proyecto "${App.project.metadata.title || sourceName}" cargado. Para llevarlo a otro dispositivo usa Exportar › Paquete del proyecto (.zip).`, 'success');
    }
  }
  if (resumed && opts.silentRestore) showToast('Sesión de trabajo reanudada.', 'info');
  updateSaveStatus('saved', App.project.metadata.last_saved);
  BiometricsEngine.updateUI();
  refreshAllCaptureNodes();
  reportMissingCaptures();
  promptAuthorIfMissing();
  if (window.Cloud) Cloud.render();
  return true;
}

async function loadProjectFromJSONFile(file, fileHandle = null) {
  if (!file) return;
  showToast('Cargando documento...', 'info');
  try {
    const name = file.name || 'documento.json';
    let isZip = /\.zip$/i.test(name);
    if (!isZip) {
      const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      isZip = head[0] === 0x50 && head[1] === 0x4B; // "PK"
    }
    if (isZip) {
      const { zip, parsed } = await readBundle(file);
      const res = await importBundleCaptures(zip, parsed);
      const ok = await loadProjectFromParsedJSON(parsed, name, { fileHandle });
      if (ok !== false) {
        let msg = `📦 Paquete abierto: ${res.restored} captura(s) restaurada(s).`;
        if (res.mismatch) msg += ` ⚠ ${res.mismatch} no coinciden con su huella registrada.`;
        showToast(msg, res.mismatch ? 'warning' : 'success');
      }
      return;
    }
    const text = await readFileAsText(file);
    if (!text || !text.trim()) throw new Error('El archivo seleccionado está vacío.');
    const parsed = JSON.parse(text);
    await loadProjectFromParsedJSON(parsed, name, { fileHandle });
  } catch (err) {
    console.error('Error al cargar archivo:', err);
    showToast('Error al abrir el archivo: ' + err.message, 'error');
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

/**
 * En Chrome/Edge de escritorio abre el .json o .zip con showOpenFilePicker para obtener
 * un handle con permiso de escritura: así el autoguardado actualiza ESE archivo.
 * Devuelve true si se manejó por esta vía.
 */
async function openJsonWithWritableHandle() {
  if (!('showOpenFilePicker' in window)) return false;
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'Proyecto Eye on the Sky (.zip o .json)',
                accept: { 'application/zip': ['.zip'], 'application/json': ['.json'] } }],
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return true; // el usuario canceló
    return false; // cualquier otro problema → usar el input clásico
  }
  let writable = false;
  try {
    writable = (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch (_) {}
  const file = await handle.getFile();
  await loadProjectFromJSONFile(file, writable ? handle : null);
  if (!writable) {
    showToast('Sin permiso de escritura: tus cambios se guardan en este navegador. Usa "Paquete del proyecto (.zip)" para llevarlos a otro dispositivo.', 'warning');
  }
  return true;
}

async function openJsonFileDialog() {
  if (await openJsonWithWritableHandle()) return;
  const onboardModal = document.getElementById('modal-onboarding-overlay');
  const isOnboardOpen = onboardModal && onboardModal.classList.contains('open');
  const input = (isOnboardOpen ? document.getElementById('onboard-file-input') : null) ||
                document.getElementById('input-load-json-direct') ||
                document.getElementById('onboard-file-input');
  if (input) {
    input.value = '';
    input.click();
  }
}

function safeClone(obj) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(obj); } catch (e) { /* fallback */ }
  }
  return JSON.parse(JSON.stringify(obj));
}

/* ================================================================
   CAPTURAS PORTABLES (IndexedDB + carpeta capturas/ + paquete .zip)
   ================================================================ */

function projectId() { return App.project?.metadata?.project_id || 'sin_proyecto'; }

async function getCaptureBlob(filename) {
  let blob = await CaptureStore.get(projectId(), filename);
  if (!blob && App.capturasHandle) {
    try {
      const fh = await App.capturasHandle.getFileHandle(filename);
      const f = await fh.getFile();
      blob = new Blob([await f.arrayBuffer()], { type: f.type || mimeFromName(filename) });
      await CaptureStore.put(projectId(), filename, blob);
    } catch (_) { blob = null; }
  }
  return blob;
}

async function getCaptureURL(filename) {
  const url = await CaptureStore.getURL(projectId(), filename);
  if (url) return url;
  const blob = await getCaptureBlob(filename);
  return blob ? CaptureStore.getURL(projectId(), filename) : null;
}

/** Registra una imagen como captura de evidencia y la guarda en el almacén portable. */
async function registerCapture(file, { source_id = null, caption = '' } = {}) {
  const originalSha = await CaptureStore.sha256Hex(file);
  const processed = await CaptureStore.processImage(file);
  const sha = processed.blob === file ? originalSha : await CaptureStore.sha256Hex(processed.blob);
  const filename = CaptureStore.newFilename(processed.mime);
  await CaptureStore.put(projectId(), filename, processed.blob);
  if (App.capturasHandle) {
    try {
      const fh = await App.capturasHandle.getFileHandle(filename, { create: true });
      const wr = await fh.createWritable();
      await wr.write(processed.blob);
      await wr.close();
    } catch (err) { console.warn('No se pudo escribir la captura en la carpeta:', err); }
  }
  if (!App.project.captures) App.project.captures = {};
  App.project.captures[filename] = {
    sha256: sha,
    original_sha256: originalSha,
    original_name: file.name || '',
    mime: processed.mime,
    size: processed.blob.size,
    width: processed.width,
    height: processed.height,
    created_at: new Date().toISOString(),
    source_id,
    caption,
    device_label: App.device?.label || '',
  };
  App.ui.isDirty = true;
  return filename;
}

/** Vuelve a adjuntar una captura que falta en este dispositivo (verifica su huella). */
async function relinkCapture(filename, file) {
  const entry = App.project.captures?.[filename];
  if (!entry) return false;
  const rawSha = await CaptureStore.sha256Hex(file);
  if (entry.sha256 && (rawSha === entry.sha256)) {
    await CaptureStore.put(projectId(), filename, file);
  } else if (entry.original_sha256 && rawSha === entry.original_sha256) {
    // Es la imagen original: se guarda tal cual y se registra su nueva huella
    await CaptureStore.put(projectId(), filename, file);
    entry.sha256 = rawSha;
    entry.relinked_at = new Date().toISOString();
  } else {
    const msg = entry.sha256 || entry.original_sha256
      ? 'Esta imagen NO es idéntica a la captura original. Si continúas, quedará registrada como REEMPLAZO (el docente lo verá). ¿Continuar?'
      : 'Esta captura proviene de una versión antigua sin huella registrada. ¿Vincular esta imagen?';
    if (!confirm(msg)) return false;
    const processed = await CaptureStore.processImage(file);
    await CaptureStore.put(projectId(), filename, processed.blob);
    const wasLegacy = !entry.sha256 && !entry.original_sha256;
    entry.sha256 = await CaptureStore.sha256Hex(processed.blob);
    entry.original_sha256 = rawSha;
    entry.mime = processed.mime; entry.size = processed.blob.size;
    entry.width = processed.width; entry.height = processed.height;
    if (wasLegacy) entry.hashed_at = new Date().toISOString();
    else { entry.replaced = true; entry.replaced_at = new Date().toISOString(); }
  }
  if (App.capturasHandle) {
    try {
      const blob = await CaptureStore.get(projectId(), filename);
      const fh = await App.capturasHandle.getFileHandle(filename, { create: true });
      const wr = await fh.createWritable(); await wr.write(blob); await wr.close();
    } catch (_) {}
  }
  App.ui.isDirty = true;
  refreshAllCaptureNodes();
  renderSourcesList();
  showToast('Captura vinculada nuevamente.', 'success');
  return true;
}

function pickImageFile() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.click();
  });
}

async function relinkCaptureInteractive(filename) {
  const file = await pickImageFile();
  if (file) await relinkCapture(filename, file);
}

/** Carpeta vinculada (PC): importa capturas de capturas/ y escribe allí las que falten. */
async function syncFolderCaptures() {
  if (!App.dirHandle) return;
  try {
    if (!App.capturasHandle) App.capturasHandle = await App.dirHandle.getDirectoryHandle('capturas', { create: true });
  } catch (_) { return; }
  const pid = projectId();
  for (const [filename, entry] of Object.entries(App.project.captures || {})) {
    let blob = await CaptureStore.get(pid, filename);
    let inFolder = null;
    try {
      const fh = await App.capturasHandle.getFileHandle(filename);
      const f = await fh.getFile();
      inFolder = new Blob([await f.arrayBuffer()], { type: f.type || mimeFromName(filename) });
    } catch (_) {}
    if (!blob && inFolder) {
      await CaptureStore.put(pid, filename, inFolder);
      blob = inFolder;
    }
    if (blob && !entry.sha256) {
      entry.sha256 = await CaptureStore.sha256Hex(blob); // captura antigua: se calcula su huella
      entry.size = blob.size;
      entry.hashed_at = new Date().toISOString();
      App.ui.isDirty = true;
    }
    if (blob && !inFolder) {
      try {
        const fh = await App.capturasHandle.getFileHandle(filename, { create: true });
        const wr = await fh.createWritable(); await wr.write(blob); await wr.close();
      } catch (_) {}
    }
  }
}

async function missingCaptures() {
  const missing = [];
  for (const filename of Object.keys(App.project.captures || {})) {
    if (!(await CaptureStore.has(projectId(), filename))) missing.push(filename);
  }
  return missing;
}

async function reportMissingCaptures() {
  const missing = await missingCaptures();
  if (missing.length) {
    showToast(`⚠ ${missing.length} captura(s) de este proyecto no están en este dispositivo. Abre el paquete .zip del proyecto o vuelve a adjuntarlas (clic sobre la captura).`, 'warning');
  }
  renderSourcesList();
}

/** Resuelve la imagen de un nodo de captura del documento. */
async function renderCaptureNode(node) {
  const filename = node.dataset.filename;
  const img = node.querySelector('img');
  const cap = node.querySelector('figcaption');
  if (!filename || !img) return;
  const url = await getCaptureURL(filename);
  if (url) {
    img.src = url;
    node.classList.remove('missing');
    if (cap) cap.textContent = `📸 ${node.dataset.caption || filename}`;
  } else {
    img.removeAttribute('src');
    node.classList.add('missing');
    if (cap) cap.textContent = `⚠ Captura "${filename}" no disponible en este dispositivo — toca aquí para volver a adjuntarla`;
  }
}

function refreshAllCaptureNodes() {
  document.querySelectorAll('#quill-editor figure.eots-capture').forEach(n => renderCaptureNode(n));
}

function handleCaptureClick(e) {
  const fig = e.target.closest && e.target.closest('figure.eots-capture');
  if (!fig) return;
  if (fig.classList.contains('missing')) {
    relinkCaptureInteractive(fig.dataset.filename);
  } else {
    getCaptureURL(fig.dataset.filename).then(url => { if (url) window.open(url, '_blank'); });
  }
}

/** Genera el paquete portable: proyecto.json + capturas/ + LEEME.txt */
async function buildBundleBlob(payload) {
  if (!window.JSZip) throw new Error('El generador de paquetes .zip no está disponible (revisa tu conexión).');
  const zip = new JSZip();
  zip.file('proyecto.json', JSON.stringify(payload, null, 2));
  const folder = zip.folder('capturas');
  const missing = [];
  for (const filename of Object.keys(App.project.captures || {})) {
    const blob = await getCaptureBlob(filename);
    if (blob) folder.file(filename, blob, { binary: true, compression: 'STORE' });
    else missing.push(filename);
  }
  zip.file('LEEME.txt',
    'Paquete de proyecto de Eye on the Sky\n' +
    '=====================================\n' +
    'Contiene el documento (proyecto.json) y todas sus capturas de evidencia (capturas/).\n\n' +
    'Para seguir trabajando en otro dispositivo: abre el editor y elige "Abrir archivo"\n' +
    'seleccionando ESTE .zip (no lo descomprimas). Las capturas se restauran solas.\n' +
    'Para entregar al docente: envía este mismo .zip.\n');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' });
  return { blob, missing };
}

async function exportBundle() {
  await saveProject({ force: true });
  try {
    const { blob, missing } = await buildBundleBlob(App.lastPayload);
    const title = App.project.metadata.title || 'documento';
    downloadBlob(blob, `${slugify(title)}_paquete.zip`, 'application/zip');
    SoundFx.play('export_success');
    if (missing.length) showToast(`Paquete descargado, pero faltan ${missing.length} captura(s) que no están en este dispositivo.`, 'warning');
    else showToast('📦 Paquete descargado (documento + capturas). Ábrelo tal cual en el otro dispositivo.', 'success');
  } catch (err) {
    showToast('No se pudo generar el paquete: ' + err.message, 'error');
  }
}

/* ================================================================
   AUTOGUARDADO
   ================================================================ */

function startAutosave() {
  if (App.session.autosave_ref) clearInterval(App.session.autosave_ref);
  App.session.autosave_ref = setInterval(async () => {
    if (!App.ui.isDirty) return;
    await saveProject();
  }, 15_000); // cada 15 segundos (en disco o en el almacenamiento del navegador)
}

let localStorageWarned = false;

async function saveProject(opts = {}) {
  updateSaveStatus('saving');

  try {
    // Capturar estado actual del editor
    if (App.quill) {
      App.project.content.delta = App.quill.getContents();
      // Las imágenes de captura se resuelven al abrir: no guardar URLs temporales blob:
      App.project.content.html  = App.quill.root.innerHTML.replace(/\s+src="blob:[^"]*"/g, '');
    }
    const titleInput = document.getElementById('doc-title-input');
    if (titleInput) {
      App.project.metadata.title = titleInput.value.trim() || App.project.metadata?.title || 'Sin título';
    }
    App.project.metadata.last_saved = new Date().toISOString();
    App.project.metadata.app_version = APP_VERSION;
    App.project.metadata.schema_version = SCHEMA_VERSION;

    if (!App.project.telemetry) App.project.telemetry = { sessions: [], summary: {} };
    if (!Array.isArray(App.project.telemetry.sessions)) App.project.telemetry.sessions = [];
    if (!App.session.id) startProjectSession();

    // Línea de tiempo de crecimiento del documento (para el gráfico del docente)
    const t = Math.round((Date.now() - (App.session.start_time || new Date()).getTime()) / 1000);
    const docChars = App.quill ? App.quill.getLength() : 0;
    const pastedChars = App.session.paste_events.reduce((a, e) => a + (e.chars_pasted || 0), 0);
    const lastPt = App.session.timeline[App.session.timeline.length - 1];
    if (!lastPt || lastPt[1] !== docChars || lastPt[3] !== pastedChars) {
      App.session.timeline.push([t, docChars, App.session.process.chars_typed, pastedChars]);
    }

    // Registro de la sesión activa (actualizar o agregar)
    const rec = buildCurrentSessionRecord();
    const sessions = App.project.telemetry.sessions;
    const existingIndex = sessions.findIndex(s => s.session_id === rec.session_id);
    if (existingIndex >= 0) sessions[existingIndex] = rec; else sessions.push(rec);

    // Compatibilidad: métricas biométricas de la última sesión válida con teclado
    const lastBio = [...sessions].reverse().find(s => s.biometrics && typeof s.biometrics.similarity_score === 'number');
    App.project.biometrics.session_metrics = lastBio ? { ...lastBio.biometrics } : null;
    App.project.biometrics.baseline = App.project.biometrics.baselines?.keyboard || null;

    // Resumen calculado con las MISMAS reglas que usa el panel docente
    const m = EOTS.computeMetrics(App.project);
    App.project.telemetry.summary = {
      total_sessions:          m.total_sessions,
      total_days_active:       m.total_days_active,
      total_devices:           m.devices.length,
      total_words_typed:       m.total_words_typed,
      total_chars_pasted:      m.total_chars_pasted,
      typed_share:             Math.round(m.typed_share * 1000) / 1000,
      undeclared_share:        Math.round(m.undeclared_share * 1000) / 1000,
      manual_ratio:            Math.round(m.typed_share * 100) / 100,
      declared_pastes:         m.pastes.notes.n + m.pastes.quote.n + m.pastes.ai.n,
      undeclared_pastes:       m.pastes.paste.n,
      sources_with_screenshot: m.sources_with_screenshot,
      sources_cited_in_text:   m.sources_cited_in_text,
      captures:                m.captures_registered,
    };

    // Registro del curso (Google Sheets): la sesión se encola y se envía en segundo plano
    if (window.Cloud && Cloud.enabled) Cloud.enqueue(rec, m);

    const payload = safeClone(App.project);
    delete payload.inline_screenshots; // sustituido por el registro de capturas
    payload._signature = await signPayload(payload);
    App.lastPayload = payload;

    // Persistir siempre en el navegador (móviles y sesiones sin carpeta)
    try {
      localStorage.setItem('eots_active_project', JSON.stringify(payload));
      localStorage.setItem('eots_active_project_name', App.project.metadata.title || 'documento.json');
    } catch (storageErr) {
      if (!localStorageWarned) {
        localStorageWarned = true;
        showToast('El almacenamiento del navegador está lleno: descarga el paquete .zip con frecuencia.', 'warning');
      }
    }

    if (App.dirHandle) {
      // Carpeta vinculada: se guarda en el MISMO .json que se abrió
      const json = JSON.stringify(payload, null, 2);
      const fileHandle = await App.dirHandle.getFileHandle(App.jsonFileName || 'documento.json', { create: true });
      const writable   = await fileHandle.createWritable();
      await writable.write(json);
      await writable.close();
    } else if (App.jsonFileHandle) {
      if (/\.zip$/i.test(App.jsonFileHandle.name)) {
        // Paquete .zip abierto en PC: se reescribe como máximo cada 60 s (incluye imágenes)
        if (opts.force || !App.lastZipWrite || Date.now() - App.lastZipWrite > 60000) {
          const { blob } = await buildBundleBlob(payload);
          const writable = await App.jsonFileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          App.lastZipWrite = Date.now();
        } else {
          App.ui.isDirty = true; // quedará pendiente para el próximo guardado
          updateSaveStatus('saved', App.project.metadata.last_saved);
          return;
        }
      } else {
        const writable = await App.jsonFileHandle.createWritable();
        await writable.write(JSON.stringify(payload, null, 2));
        await writable.close();
      }
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
   GUARDADO MANUAL CON MODAL DE ESTADÍSTICAS (acumuladas del proyecto)
   ================================================================ */

async function saveProjectWithStats() {
  await saveProject({ force: true });

  const docTitle = App.project.metadata?.title || 'Sin título';
  const lastSaved = App.project.metadata?.last_saved;
  const m = EOTS.computeMetrics(App.project);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  set('stats-doc-title', docTitle);
  if (lastSaved) set('stats-doc-saved-at', `Guardado: ${new Date(lastSaved).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' })}`);
  set('stats-word-count', m.word_count.toLocaleString('es'));
  set('stats-words-typed', m.total_words_typed.toLocaleString('es'));
  set('stats-manual-ratio', m.word_count ? EOTS.pct(m.typed_share) : '—');
  const sbTimer = document.getElementById('sb-session-time');
  if (sbTimer) set('stats-session-time', `${sbTimer.textContent.replace('Sesión: ', '')} · ${m.total_sessions} ses.`);
  set('stats-sources-count', `${m.sources_with_screenshot}/${m.sources_count}`);
  set('stats-paste-events', `${m.pastes.paste.n} / ${m.pastes.notes.n + m.pastes.quote.n + m.pastes.ai.n}`);

  try {
    const stored = localStorage.getItem('eots_active_project') || '';
    const bytes = new Blob([stored]).size;
    let sizeStr;
    if (bytes < 1024) sizeStr = `${bytes} B`;
    else if (bytes < 1024 * 1024) sizeStr = `${(bytes / 1024).toFixed(1)} KB`;
    else sizeStr = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    set('stats-json-size', `${sizeStr} + ${Object.keys(App.project.captures || {}).length} captura(s)`);
  } catch (e) {
    set('stats-json-size', '—');
  }

  SoundFx.play('autosave_peace');
  openModal('modal-save-stats-overlay');
}

/* ================================================================
   AUTOR DEL TRABAJO (nombre y correo para el reporte del docente)
   ================================================================ */

function syncAuthorInputs() {
  const n = document.getElementById('author-name-input');
  const e = document.getElementById('author-email-input');
  if (n) n.value = App.project.metadata?.student_name || '';
  if (e) e.value = App.project.metadata?.student_email || '';
  // Con sesión iniciada los datos son los de la lista del docente (no editables aquí)
  const locked = !!(window.Cloud && Cloud.isLoggedIn());
  [n, e].forEach(el => { if (el) { el.readOnly = locked; el.title = locked ? 'Dato de la lista oficial del curso' : ''; } });
}

function promptAuthorIfMissing() {
  // Con registro del curso, el nombre y el correo vienen de la lista oficial del docente
  if (window.Cloud && Cloud.enabled) { if (Cloud.isLoggedIn()) Cloud.applyIdentity(); return; }
  const md = App.project.metadata || {};
  if (md.student_name && md.student_email) return;
  const n = document.getElementById('modal-author-name');
  const e = document.getElementById('modal-author-email');
  if (n) n.value = md.student_name || '';
  if (e) e.value = md.student_email || '';
  setTimeout(() => openModal('modal-author-overlay'), 400);
}

function saveAuthorFromModal() {
  const name = (document.getElementById('modal-author-name')?.value || '').trim();
  const email = (document.getElementById('modal-author-email')?.value || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('El correo no parece válido.', 'warning');
    return;
  }
  App.project.metadata.student_name = name;
  App.project.metadata.student_email = email;
  syncAuthorInputs();
  closeModal('modal-author-overlay');
  App.ui.isDirty = true;
  saveProject();
}

/* ================================================================
   FIRMA CRIPTOGRÁFICA (SHA-256) PARA DETECTAR MANIPULACIÓN
   ================================================================ */

async function signPayload(payload) {
  const clone = safeClone(payload);
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

  // Al editar, no perder el estado "citado en texto", la fecha de alta, la clave BibTeX
  // ni la captura existente
  if (App.ui.editingSourceId) {
    const prev = App.project.sources.find(s => s.id === App.ui.editingSourceId);
    if (prev) {
      source.cited_in_text = !!prev.cited_in_text;
      source.quoted_in_text = !!prev.quoted_in_text;
      source.added_at      = prev.added_at || source.added_at;
      source.screenshot_filename = prev.screenshot_filename || null;
      if (prev.bibtex_key) source.bibtex_key = prev.bibtex_key;
    }
  }

  // Captura de evidencia: se guarda en el almacén portable (funciona también en celulares)
  if (App.ui.pendingScreenshot) {
    try {
      source.screenshot_filename = await registerCapture(App.ui.pendingScreenshot.file,
        { source_id: source.id, caption: source.title });
    } catch (err) {
      showToast('No se pudo guardar la captura: ' + err.message, 'error');
    }
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
  const countBadge = document.getElementById('sources-count-badge');
  if (countBadge) countBadge.textContent = App.project.sources.length;

  const container = document.getElementById('sources-list');
  if (!container) return;
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
    const sid = escapeHtml(src.id);

    const card = document.createElement('div');
    card.className = 'source-card fade-in';
    card.dataset.id = src.id;
    card.innerHTML = `
      <div class="source-card-title">${escapeHtml(src.title)}</div>
      <div class="source-card-meta">
        <span>${escapeHtml(authorShort)}</span>
        <span>${escapeHtml(String(src.year || '—'))}</span>
        ${src.doi ? `<span title="${escapeHtml(src.doi)}">DOI ✓</span>` : ''}
      </div>
      <div style="margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap;">
        <span class="source-card-badge">${typeLabel(src.type)}</span>
        ${src.screenshot_filename
          ? `<span class="source-card-badge has-screenshot" data-capture-badge="${escapeHtml(src.screenshot_filename)}">📸 Captura</span>`
          : `<span class="source-card-badge" style="background:var(--warning-light);color:var(--warning);">Sin captura</span>`}
        ${src.cited_in_text ? `<span class="source-card-badge">Citado en texto</span>` : ''}
        ${src.quoted_in_text ? `<span class="source-card-badge">Cita textual</span>` : ''}
      </div>
      <div class="source-card-actions">
        <button class="btn btn-sm btn-ghost" onclick="openAddSourceModal('${sid}')">Editar</button>
        <button class="btn btn-sm btn-ghost" onclick="insertCitationFromSource('${sid}')">Citar</button>
        <button class="btn btn-sm btn-ghost text-danger" onclick="deleteSource('${sid}')">Eliminar</button>
        ${src.screenshot_filename ? `<button class="btn btn-sm btn-ghost" onclick="viewScreenshot('${sid}')">Ver captura</button>` : ''}
      </div>
    `;
    container.appendChild(card);
  });

  // Marcar las capturas que no están disponibles en este dispositivo
  container.querySelectorAll('[data-capture-badge]').forEach(async badge => {
    const filename = badge.getAttribute('data-capture-badge');
    if (!(await CaptureStore.has(projectId(), filename)) && !(await getCaptureBlob(filename))) {
      badge.textContent = '⚠ Captura no está en este dispositivo';
      badge.style.background = 'var(--warning-light)';
      badge.style.color = 'var(--warning)';
      badge.style.cursor = 'pointer';
      badge.title = 'Abre el paquete .zip del proyecto o haz clic para volver a adjuntar la imagen';
      badge.onclick = () => relinkCaptureInteractive(filename);
    }
  });
}

async function viewScreenshot(sourceId) {
  const src = App.project.sources.find(s => s.id === sourceId);
  if (!src || !src.screenshot_filename) return;
  const url = await getCaptureURL(src.screenshot_filename);
  if (url) {
    window.open(url, '_blank');
  } else if (confirm('Esta captura no está en este dispositivo. ¿Quieres volver a adjuntar la imagen ahora?')) {
    relinkCaptureInteractive(src.screenshot_filename);
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

function normalizeAuthorName(a) {
  if (!a) return { lastName: 'Anónimo', firstName: '', raw: 'Anónimo' };
  const str = a.trim();
  if (str.includes(',')) {
    const parts = str.split(',');
    return {
      lastName: parts[0].trim(),
      firstName: parts.slice(1).join(' ').trim(),
      raw: str
    };
  }
  const tokens = str.split(/\s+/);
  if (tokens.length >= 2) {
    return {
      lastName: tokens[tokens.length - 1],
      firstName: tokens.slice(0, -1).join(' '),
      raw: str
    };
  }
  return { lastName: str, firstName: '', raw: str };
}

/** Apellidos para citas en el texto según el número de autores. */
function inTextAuthors(authors, style) {
  const last = authors.map(a => normalizeAuthorName(a).lastName);
  if (last.length === 0) return 'Anónimo';
  if (last.length === 1) return last[0];
  if (last.length === 2) return style === 'apa' ? `${last[0]} & ${last[1]}` : `${last[0]} y ${last[1]}`;
  if (style === 'chicago-author-date' && last.length === 3) return `${last[0]}, ${last[1]} y ${last[2]}`;
  return `${last[0]} et al.`;
}

/**
 * Cita en el texto (devuelve HTML con <em> para cursivas).
 *  - chicago-note:        nota completa  → Apellido, Nombre, "Título," Revista (Año), pág.
 *  - chicago-author-date: (Apellido Año, pág.)
 *  - apa:                 (Apellido, Año, p. pág.)
 *  - mla:                 (Apellido pág.)
 */
function formatCitation(src, pages, style) {
  const authors = src.authors || [];
  const year    = src.year || 's. f.';
  const title   = escapeHtml(src.title || '');
  const journal = escapeHtml(src.journal || '');
  const pgs     = (pages || '').trim();

  if (style === 'chicago-author-date') {
    return `(${escapeHtml(inTextAuthors(authors, style))} ${year}${pgs ? `, ${escapeHtml(pgs)}` : ''})`;
  }
  if (style === 'apa') {
    const p = pgs ? `, ${/[-–,]/.test(pgs) ? 'pp.' : 'p.'} ${escapeHtml(pgs)}` : '';
    return `(${escapeHtml(inTextAuthors(authors, style))}, ${year}${p})`;
  }
  if (style === 'mla') {
    return `(${escapeHtml(inTextAuthors(authors, style))}${pgs ? ` ${escapeHtml(pgs)}` : ''})`;
  }
  // Chicago, nota completa (por defecto)
  const authorStr = authors.length > 0
    ? authors.map((a, i) => {
        const n = normalizeAuthorName(a);
        if (i === 0) return n.firstName ? `${n.firstName} ${n.lastName}` : n.lastName;
        return n.firstName ? `${n.firstName} ${n.lastName}` : n.lastName;
      }).join(', ')
    : 'Autor desconocido';
  const pg = pgs ? `, ${escapeHtml(pgs)}` : '';
  if (src.type === 'journal') {
    return `${escapeHtml(authorStr)}, "${title}," <em>${journal}</em> (${year})${pg}.`;
  }
  return `${escapeHtml(authorStr)}, <em>${title}</em> (${year})${pg}.`;
}

function reverseAuthorName(name) {
  const norm = normalizeAuthorName(name);
  return norm.firstName ? `${norm.firstName} ${norm.lastName}` : norm.lastName;
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

  // Insertar en la posición actual del cursor de forma protegida ante pérdida de foco (ej. en iOS)
  const range = (App.quill && App.quill.getSelection()) || { index: Math.max(0, (App.quill ? App.quill.getLength() : 1) - 1), length: 0 };
  const insertIndex = (range && typeof range.index === 'number') ? range.index : Math.max(0, (App.quill ? App.quill.getLength() : 1) - 1);

  // formatCitation devuelve HTML (<em>revista</em>). Antes se insertaba tal cual como
  // texto plano y en el documento aparecían las etiquetas "<em>". Ahora se inserta
  // por tramos, con cursiva real donde corresponde.
  const segments = [];
  citation.split(/(<em>.*?<\/em>)/g).forEach(part => {
    if (!part) return;
    const m = part.match(/^<em>(.*)<\/em>$/);
    const txt = EOTS.htmlToText(m ? m[1] : part);
    if (txt) segments.push({ text: txt, italic: !!m });
  });

  let cursor = insertIndex;
  runAsSystemInsert(() => {
    segments.forEach(seg => {
      App.quill.insertText(cursor, seg.text,
        { background: PROVENANCE_BG.citation, italic: seg.italic || false }, 'user');
      cursor += seg.text.length;
    });
    // Un espacio limpio al final: el texto que se escriba después NO hereda el púrpura
    App.quill.insertText(cursor, ' ', { background: false, italic: false }, 'user');
    cursor += 1;
  });
  App.quill.setSelection(cursor, 0, 'silent');

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
  // Recordar la posición del cursor antes de abrir el selector de archivos
  const range = App.quill ? App.quill.getSelection() : null;
  const file = await pickImageFile();
  if (!file) return;
  await embedScreenshotInEditor(file, range);
}

async function embedScreenshotInEditor(file, savedRange = null) {
  try {
    const caption = (prompt('Pie de la captura (opcional): por ejemplo, "Pérez 2020, p. 45"', '') || '').trim();
    const filename = await registerCapture(file, { caption });
    const fallbackIndex = Math.max(0, (App.quill ? App.quill.getLength() : 1) - 1);
    const insertIndex = (savedRange && typeof savedRange.index === 'number') ? savedRange.index : fallbackIndex;
    runAsSystemInsert(() => {
      App.quill.insertEmbed(insertIndex, 'eots-capture', { filename, caption }, 'user');
    });
    App.quill.setSelection(insertIndex + 1, 0, 'silent');
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
    showToast('📸 Captura insertada. Viaja con el proyecto dentro del paquete .zip.', 'success');
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
// La interfaz del editor ocupa exactamente la pantalla (alto fijo con desplazamiento
// interno), así que imprimirla tal cual produce UNA sola página. Para el PDF se arma una
// copia limpia del documento en #print-root, que fluye libremente en todas las páginas.
function buildPrintRoot() {
  document.getElementById('print-root')?.remove();
  const root = document.createElement('div');
  root.id = 'print-root';
  const title = App.project.metadata.title || 'Sin título';
  const h = document.createElement('h1');
  h.className = 'print-title';
  h.textContent = title;
  root.appendChild(h);

  const body = document.createElement('div');
  body.className = 'ql-editor print-body';
  body.innerHTML = App.quill ? App.quill.root.innerHTML : '';
  // Sin interfaz de edición: placeholders, botones y estados de las tablas/capturas
  body.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
  body.querySelectorAll('button, .table-toolbar, .eots-table-toolbar, .ql-tooltip').forEach(el => el.remove());
  root.appendChild(body);

  // Bibliografía al final si el documento aún no la incluye (igual que en Word)
  const text = body.textContent || '';
  const already = Array.from(body.querySelectorAll('h1,h2,h3')).some(x => /^(bibliograf|referencias|obras citadas)/i.test(x.textContent.trim()));
  if (!already && text && (App.project.sources || []).length) {
    const style = projectCitationStyle();
    const bh = document.createElement('h1');
    bh.textContent = style === 'apa' ? 'Referencias' : style === 'mla' ? 'Obras citadas' : 'Bibliografía';
    body.appendChild(bh);
    App.project.sources.forEach(src => {
      const p = document.createElement('p');
      p.className = 'print-bib';
      p.innerHTML = formatBibliographyEntry(src, style);
      body.appendChild(p);
    });
  }
  document.body.appendChild(root);
  return root;
}

function endPrintMode() {
  document.body.classList.remove('printing-doc');
  document.getElementById('print-root')?.remove();
}
function startPrintMode() {
  if (!App.project) return;
  buildPrintRoot();
  document.body.classList.add('printing-doc');
}
// También cuando se imprime con Ctrl+P o desde el menú del navegador
window.addEventListener('beforeprint', () => { if (!document.body.classList.contains('printing-doc')) startPrintMode(); });
window.addEventListener('afterprint', endPrintMode);

function exportToPDF() {
  SoundFx.play('export_success');
  startPrintMode();
  // Dar tiempo a que carguen las imágenes de las capturas antes de abrir el diálogo
  const imgs = Array.from(document.querySelectorAll('#print-root img'));
  Promise.all(imgs.map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; setTimeout(r, 3000); })))
    .then(() => {
      window.print();
      // Algunos navegadores móviles no emiten afterprint
      setTimeout(() => { if (document.body.classList.contains('printing-doc')) endPrintMode(); }, 60000);
    });
}

// --- Word (.docx) usando la librería docx ---
async function exportToDocx() {
  if (!window.docx) {
    showToast('Librería DOCX no disponible. Verifica tu conexión a internet.', 'error');
    return;
  }
  showToast('Generando documento Word…', 'info');

  const { Document, Paragraph, TextRun, HeadingLevel, Packer, AlignmentType,
          ImageRun, Table, TableRow, TableCell, WidthType } = window.docx;

  const title = App.project.metadata.title || 'Sin título';
  const delta = App.quill ? App.quill.getContents() : null;
  const children = [];
  const headings = [null, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5];
  const alignOf = a => a === 'center' ? AlignmentType.CENTER : a === 'right' ? AlignmentType.RIGHT : a === 'justify' ? AlignmentType.JUSTIFIED : AlignmentType.LEFT;
  let hasBibliography = false;

  let runs = [];
  let olCounter = 0;
  const flush = (attrs = {}) => {
    const text = runs.map(r => r._t).join('');
    if (attrs.header && /^(bibliograf|referencias|obras citadas)/i.test(text.trim())) hasBibliography = true;
    const list = attrs.list;
    olCounter = list === 'ordered' ? olCounter + 1 : 0;
    const prefix = list === 'ordered' ? [new TextRun(olCounter + '. ')] : [];
    children.push(new Paragraph({
      children: prefix.concat(runs.length ? runs.map(r => r.run) : [new TextRun('')]),
      alignment: alignOf(attrs.align),
      heading: headings[attrs.header] || undefined,
      bullet: list === 'bullet' ? { level: 0 } : undefined,
      indent: list === 'ordered' ? { left: 720, hanging: 360 } : attrs.blockquote ? { left: 720 } : undefined,
      spacing: { after: list ? 60 : 180, line: 276 },
    }));
    runs = [];
  };
  const imageSize = src => new Promise(res => { const im = new Image(); im.onload = () => res([im.naturalWidth || 400, im.naturalHeight || 300]); im.onerror = () => res([400, 300]); im.src = src; });

  for (const op of (delta?.ops || [])) {
    if (typeof op.insert === 'string') {
      const parts = op.insert.split('\n');
      parts.forEach((part, i) => {
        if (part.length > 0) {
          const run = new TextRun({
            text: part,
            bold: !!op.attributes?.bold,
            italics: !!op.attributes?.italic,
            underline: op.attributes?.underline ? {} : undefined,
          });
          runs.push({ run, _t: part });
        }
        if (i < parts.length - 1) flush(op.attributes || {});
      });
    } else if (op.insert && op.insert['eots-capture']) {
      if (runs.length) flush();
      const v = op.insert['eots-capture'];
      const blob = await getCaptureBlob(v.filename);
      const meta = App.project.captures?.[v.filename] || {};
      if (blob && ImageRun) {
        const w0 = meta.width || 800, h0 = meta.height || 600;
        const scale = Math.min(1, 560 / w0);
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new ImageRun({ data: await blob.arrayBuffer(), transformation: { width: Math.round(w0 * scale), height: Math.round(h0 * scale) } })],
        }));
      }
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: v.caption || (blob ? v.filename : `[Captura no disponible: ${v.filename}]`), italics: true, size: 18 })],
      }));
    } else if (op.insert && typeof op.insert.image === 'string' && ImageRun) {
      // Imagen pegada o insertada directamente (no es una captura registrada)
      try {
        if (runs.length) flush();
        const src = op.insert.image;
        const buf = await (await fetch(src)).arrayBuffer();
        const [w0, h0] = await imageSize(src);
        const scale = Math.min(1, 560 / w0);
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: buf, transformation: { width: Math.round(w0 * scale), height: Math.round(h0 * scale) } })] }));
      } catch (_) { /* imagen inaccesible: se omite */ }
    } else if (op.insert && op.insert['academic-table'] && Table) {
      if (runs.length) flush();
      const holder = document.createElement('div');
      holder.innerHTML = op.insert['academic-table'].html || '';
      const rows = Array.from(holder.querySelectorAll('tr')).map(tr => new TableRow({
        children: Array.from(tr.children).map(cell => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: cell.textContent || '', bold: cell.tagName === 'TH' })] })],
        })),
      }));
      if (rows.length) children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      children.push(new Paragraph(''));
    }
  }
  if (runs.length) flush();

  // Bibliografía al final solo si el documento aún no la incluye
  if (!hasBibliography && (App.project.sources || []).length) {
    const style = projectCitationStyle();
    const heading = style === 'apa' ? 'Referencias' : style === 'mla' ? 'Obras citadas' : 'Bibliografía';
    children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }));
    App.project.sources.forEach(src => {
      const html = formatBibliographyEntry(src, style);
      const segs = html.split(/(<em>.*?<\/em>)/g).filter(Boolean).map(seg => {
        const m = seg.match(/^<em>(.*)<\/em>$/);
        return new TextRun({ text: EOTS.htmlToText(m ? m[1] : seg), italics: !!m });
      });
      children.push(new Paragraph({ children: segs, spacing: { after: 150 }, indent: { left: 720, hanging: 720 } }));
    });
  }

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: title, heading: HeadingLevel.TITLE, spacing: { after: 300 } }),
        ...children,
      ],
    }],
  });

  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, `${slugify(title)}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  SoundFx.play('export_success');
  showToast('Documento Word exportado.', 'success');
}

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
// --- Solo los datos (.json) — sin capturas ---
async function exportJSON() {
  await saveProject({ force: true });
  const nCaps = Object.keys(App.project.captures || {}).length;
  if (nCaps > 0 && !confirm(`El archivo .json NO incluye las ${nCaps} captura(s) del proyecto.\n\nPara cambiar de dispositivo o entregar al docente usa "Paquete del proyecto (.zip)".\n\n¿Descargar de todos modos solo el .json?`)) {
    return;
  }
  const payload = App.lastPayload || safeClone(App.project);
  const blob  = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const title = App.project.metadata.title || 'documento';
  downloadBlob(blob, `${slugify(title)}_respaldo.json`, 'application/json');
  SoundFx.play('export_success');
  showToast('Copia de datos (.json) descargada.', 'success');
}

/* ================================================================
   UTILIDADES
   ================================================================ */

function downloadBlob(blob, filename, type) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url;
  a.download = filename;
  if (type) a.type = type;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(w => w.length > 0).length;
}

function updateWordCount(count) {
  const sbWc = document.getElementById('sb-word-count');
  if (sbWc) sbWc.textContent = `${count} palabras`;
  const mobWc = document.getElementById('mob-word-count-badge');
  if (mobWc) mobWc.textContent = `${count} palabras`;
}

function updateSaveStatus(state, isoDate) {
  const el   = document.getElementById('save-status');
  const text = document.getElementById('save-status-text');
  if (el) el.classList.remove('saving', 'unsaved', 'error');

  if (state === 'saving') {
    if (el) el.classList.add('saving');
    if (text) text.textContent = 'Guardando…';
  } else if (state === 'saved') {
    const t = isoDate ? new Date(isoDate).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
    if (text) text.textContent = `Guardado ${t}`;
  } else if (state === 'unsaved') {
    if (el) el.classList.add('unsaved');
    if (text) text.textContent = 'Sin guardar';
  } else if (state === 'error') {
    if (el) el.classList.add('error');
    if (text) text.textContent = 'Error al guardar';
  }
  if (typeof updateMobileMenuUI === 'function') updateMobileMenuUI();
}

function generateId() {
  return 'src-' + Math.random().toString(36).slice(2, 11);
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function slugify(str) {
  if (!str) return 'documento';
  return str
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // convierte á->a, é->e, ñ->n, etc.
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .substring(0, 60) || 'documento';
}

function typeLabel(type) {
  const map = { journal:'Artículo', book:'Libro', chapter:'Capítulo', thesis:'Tesis',
    conference:'Ponencia', website:'Web', report:'Reporte' };
  return map[type] || type;
}

function openModal(id)  {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('open');
  }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('open');
  }
}
window.openModal = openModal;
window.closeModal = closeModal;

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
  const iconLight = document.getElementById('theme-icon-light');
  const iconDark = document.getElementById('theme-icon-dark');
  if (iconLight) iconLight.classList.toggle('hidden', theme === 'dark');
  if (iconDark) iconDark.classList.toggle('hidden', theme === 'light');
  if (typeof updateMobileMenuUI === 'function') updateMobileMenuUI();
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
    btnCloseOnboard.addEventListener('click', async () => {
      closeModal('modal-onboarding-overlay');
      if (!App.ui.projectLoaded) {
        await createNewProjectDirectly();
      }
    });
  }

  // Carga directa mediante input file nativo (onboard-file-input)
  const inputOnboardFile = document.getElementById('onboard-file-input');
  if (inputOnboardFile && 'showOpenFilePicker' in window) {
    // En PC: abrir con handle escribible para guardar de vuelta en el mismo archivo
    inputOnboardFile.addEventListener('click', (e) => {
      e.preventDefault();
      openJsonWithWritableHandle().then((handled) => {
        if (!handled) {
          // Fallback al selector clásico
          const alt = document.getElementById('input-load-json-direct');
          if (alt) { alt.value = ''; alt.click(); }
        }
      });
    });
  }
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
      if (files && files[0] && /\.(json|zip)$/i.test(files[0].name)) {
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
  document.getElementById('btn-open-folder').addEventListener('click', () => {
    if (!('showDirectoryPicker' in window)) {
      openJsonFileDialog();
    } else {
      openOrCreateProject('open');
    }
  });

  // Funciones de control de paneles laterales

  /**
   * Alterna o activa el panel izquierdo en la pestaña "Fuentes".
   * - Si el panel está cerrado: lo abre y activa la pestaña "Fuentes".
   * - Si está abierto pero mostrando otra pestaña (ej. TOC): cambia a la pestaña "Fuentes" sin cerrar.
   * - Si ya está abierto mostrando la pestaña "Fuentes": lo cierra (toggle).
   */
  function toggleSourcesPanel() {
    const sidebar = document.getElementById('sidebar-sources');
    if (!sidebar) return;

    const isCollapsed = sidebar.classList.contains('collapsed');
    const isAlreadyOnSources = !isCollapsed && App.ui.activeSidebarTab === 'sources';

    if (isAlreadyOnSources) {
      sidebar.classList.add('collapsed');
      App.ui.sourcesPanelOpen = false;
    } else {
      sidebar.classList.remove('collapsed');
      App.ui.sourcesPanelOpen = true;
      switchSidebarTab('sources');
      if (window.innerWidth <= 900) {
        const tele = document.getElementById('sidebar-telemetry');
        App.ui.telePanelOpen = false;
        if (tele) tele.classList.add('collapsed');
      }
    }
    updatePanelBackdrop();
    if (typeof updateMobileMenuUI === 'function') updateMobileMenuUI();
  }
  window.toggleSourcesPanel = toggleSourcesPanel;
  window.openSourcesPanel = toggleSourcesPanel;

  /**
   * Alterna o activa el panel izquierdo en la pestaña "Contenido / TOC".
   * - Si el panel está cerrado: lo abre y activa la pestaña "TOC".
   * - Si está abierto pero mostrando otra pestaña (ej. Fuentes): cambia a la pestaña "TOC" sin cerrar.
   * - Si ya está abierto mostrando la pestaña "TOC": lo cierra (toggle).
   */
  function toggleTocPanel() {
    const sidebar = document.getElementById('sidebar-sources');
    if (!sidebar) return;

    const isCollapsed = sidebar.classList.contains('collapsed');
    const isAlreadyOnToc = !isCollapsed && App.ui.activeSidebarTab === 'toc';

    if (isAlreadyOnToc) {
      sidebar.classList.add('collapsed');
      App.ui.sourcesPanelOpen = false;
    } else {
      sidebar.classList.remove('collapsed');
      App.ui.sourcesPanelOpen = true;
      switchSidebarTab('toc');
      updateTableOfContents();
      if (window.innerWidth <= 900) {
        const tele = document.getElementById('sidebar-telemetry');
        App.ui.telePanelOpen = false;
        if (tele) tele.classList.add('collapsed');
      }
    }
    updatePanelBackdrop();
    if (typeof updateMobileMenuUI === 'function') updateMobileMenuUI();
  }
  window.toggleTocPanel = toggleTocPanel;
  window.openTocPanel = toggleTocPanel;

  function toggleTelemetryPanel(forceOpen) {
    const sidebar = document.getElementById('sidebar-telemetry');
    if (!sidebar) return;
    const isCurrentlyOpen = !sidebar.classList.contains('collapsed');
    const shouldOpen = (typeof forceOpen === 'boolean') ? forceOpen : !isCurrentlyOpen;
    App.ui.telePanelOpen = shouldOpen;
    sidebar.classList.toggle('collapsed', !shouldOpen);
    if (shouldOpen) { updateTelemetryUI(); if (window.Cloud) Cloud.markStudentAlertsSeen(); }
    if (shouldOpen && window.innerWidth <= 900) {
      const src = document.getElementById('sidebar-sources');
      App.ui.sourcesPanelOpen = false;
      if (src) src.classList.add('collapsed');
    }
    updatePanelBackdrop();
    if (typeof updateMobileMenuUI === 'function') updateMobileMenuUI();
  }
  window.toggleTelemetryPanel = toggleTelemetryPanel;

  // Toggle sidebars botones barra superior (Desktop)
  const btnToggleSources = document.getElementById('btn-toggle-sources');
  if (btnToggleSources) {
    btnToggleSources.addEventListener('click', toggleSourcesPanel);
  }

  const btnToggleTele = document.getElementById('btn-toggle-tele');
  if (btnToggleTele) {
    btnToggleTele.addEventListener('click', () => toggleTelemetryPanel());
  }

  const btnToggleToc = document.getElementById('btn-toggle-toc');
  if (btnToggleToc) {
    btnToggleToc.addEventListener('click', toggleTocPanel);
  }

  // Atajos superiores coloreados (Móviles / Pantallas reducidas)
  const btnNavSources = document.getElementById('btn-nav-sources');
  if (btnNavSources) {
    btnNavSources.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSourcesPanel();
    });
  }
  const btnNavToc = document.getElementById('btn-nav-toc');
  if (btnNavToc) {
    btnNavToc.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleTocPanel();
    });
  }
  const btnNavTele = document.getElementById('btn-nav-tele');
  if (btnNavTele) {
    btnNavTele.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleTelemetryPanel();
    });
  }

  // Botón cerrar en la cabecera del panel de telemetría
  const btnCloseTele = document.getElementById('btn-close-tele');
  if (btnCloseTele) {
    btnCloseTele.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleTelemetryPanel(false);
    });
  }

  // Tema
  document.getElementById('btn-theme').addEventListener('click', () => {
    applyTheme(App.ui.currentTheme === 'light' ? 'dark' : 'light');
  });

  // Título del documento
  document.getElementById('doc-title-input').addEventListener('input', () => {
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
    const titleVal = document.getElementById('doc-title-input').value || 'Sin título';
    document.title = `${titleVal} — Eye on the Sky`;
    // Actualizar el nombre en la barra de estado inferior
    const sbName = document.getElementById('sb-project-name');
    if (sbName && !App.dirHandle) sbName.textContent = titleVal;
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
  const exportBundleBtn = document.getElementById('export-bundle');
  if (exportBundleBtn) exportBundleBtn.addEventListener('click', exportBundle);

  // Declaración de pegados
  document.querySelectorAll('input[name="paste-kind"]').forEach(r => r.addEventListener('change', updatePasteDeclareForm));
  const pdConfirm = document.getElementById('paste-declare-confirm');
  if (pdConfirm) pdConfirm.addEventListener('click', () => resolvePasteDeclaration(true));
  const pdSkip = document.getElementById('paste-declare-skip');
  if (pdSkip) pdSkip.addEventListener('click', () => resolvePasteDeclaration(false));

  // Autor del trabajo (nombre y correo para el reporte docente)
  const authorName = document.getElementById('author-name-input');
  const authorEmail = document.getElementById('author-email-input');
  const onAuthor = () => {
    App.project.metadata.student_name = (authorName?.value || '').trim();
    App.project.metadata.student_email = (authorEmail?.value || '').trim();
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
  };
  if (authorName) authorName.addEventListener('input', onAuthor);
  if (authorEmail) authorEmail.addEventListener('input', onAuthor);
  const authorSave = document.getElementById('modal-author-save');
  if (authorSave) authorSave.addEventListener('click', saveAuthorFromModal);
  const authorLater = document.getElementById('modal-author-later');
  if (authorLater) authorLater.addEventListener('click', () => closeModal('modal-author-overlay'));

  // Agregar fuente
  document.getElementById('btn-add-source').addEventListener('click', () => openAddSourceModal());
  document.getElementById('btn-insert-citation').addEventListener('click', () => openCitationModal());
  document.getElementById('btn-insert-screenshot').addEventListener('click', insertScreenshotAtCursor);

  // Pestañas del sidebar izquierdo (Fuentes / Contenido TOC)
  initSidebarTabs();

  // Botones de Indentación: Izquierda, Derecha, Ambas
  const btnIndLeft = document.getElementById('btn-indent-left');
  if (btnIndLeft) btnIndLeft.addEventListener('click', applyIndentLeft);
  const btnIndRight = document.getElementById('btn-indent-right');
  if (btnIndRight) btnIndRight.addEventListener('click', applyIndentRight);
  const btnIndBoth = document.getElementById('btn-indent-both');
  if (btnIndBoth) btnIndBoth.addEventListener('click', applyIndentBoth);

  // Tabla: abrir modal y confirmar inserción
  const btnInsTable = document.getElementById('btn-insert-table');
  if (btnInsTable) btnInsTable.addEventListener('click', openTableModal);
  const btnConfTable = document.getElementById('btn-confirm-insert-table');
  if (btnConfTable) btnConfTable.addEventListener('click', insertTableAtCursor);
  const btnCloseTable = document.getElementById('close-modal-table');
  if (btnCloseTable) btnCloseTable.addEventListener('click', closeTableModal);
  const btnCancelTable = document.getElementById('cancel-modal-table');
  if (btnCancelTable) btnCancelTable.addEventListener('click', closeTableModal);

  // TOC: actualizar e insertar
  const btnRefreshToc = document.getElementById('btn-refresh-toc');
  if (btnRefreshToc) btnRefreshToc.addEventListener('click', () => {
    updateTableOfContents();
    showToast('Índice actualizado.', 'info');
  });
  const btnInsertToc = document.getElementById('btn-insert-toc');
  if (btnInsertToc) btnInsertToc.addEventListener('click', insertTableOfContentsIntoDoc);
  const btnInsertTocTb = document.getElementById('btn-insert-toc-tb');
  if (btnInsertTocTb) btnInsertTocTb.addEventListener('click', insertTableOfContentsIntoDoc);

  // Bibliografía: insertar en documento
  const btnInsertBibTb = document.getElementById('btn-insert-bib-tb');
  if (btnInsertBibTb) btnInsertBibTb.addEventListener('click', insertBibliographyIntoDoc);

  // Scrollbar: scroll y arrastre para actualizar indicador de página y tooltip
  const editorArea = document.getElementById('editor-area');
  if (editorArea) {
    editorArea.addEventListener('scroll', () => {
      updatePageMetrics(true);
    });

    let isDraggingScroll = false;
    editorArea.addEventListener('pointerdown', (e) => {
      const rect = editorArea.getBoundingClientRect();
      if (e.clientX >= rect.right - 28) {
        isDraggingScroll = true;
        updatePageMetrics(true);
      }
    });
    window.addEventListener('pointerup', () => {
      isDraggingScroll = false;
    });
    window.addEventListener('pointermove', (e) => {
      if (isDraggingScroll) {
        updatePageMetrics(true);
      }
    });
  }

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
      ['modal-source-overlay','modal-citation-overlay','modal-biometrics-overlay','modal-save-stats-overlay','modal-table-overlay','modal-author-overlay'].forEach(id => closeModal(id));
      if (document.getElementById('modal-paste-overlay')?.classList.contains('open')) resolvePasteDeclaration(false);
      closeMobileMenu();
    }
  });

  // Guardar con Ctrl+S
  document.addEventListener('keydown', async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      await saveProjectWithStats();
    }
  });

  // Guardado automático al cambiar de pestaña o minimizar ventana (PC y móviles Android/iOS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && App.ui.isDirty && App.ui.projectLoaded) {
      saveProject();
    }
  });

  // Guardado crítico en iOS Safari y móviles al suspender o cambiar de app
  window.addEventListener('pagehide', () => {
    if (App.ui.isDirty && App.ui.projectLoaded) {
      saveProject();
    }
  });

  // Aviso antes de cerrar si hay cambios
  window.addEventListener('beforeunload', (e) => {
    if (App.ui.isDirty && App.ui.projectLoaded) {
      saveProject();
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Notificaciones de estado de conexión (offline / online)
  window.addEventListener('offline', () => {
    showToast('Estás trabajando sin conexión. Tus avances se siguen guardando localmente.', 'info');
  });
  window.addEventListener('online', () => {
    showToast('Conexión a internet restablecida.', 'success');
  });


  // Adaptar interfaz ante rotación o cambio de tamaño de ventana (portrait <-> landscape)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      adaptUIForPlatform();
      updatePanelBackdrop();
    }, 200);
  });

  // Botón de guardado manual con estadísticas (desktop)
  const btnManualSave = document.getElementById('btn-manual-save');
  if (btnManualSave) {
    btnManualSave.addEventListener('click', () => saveProjectWithStats());
  }

  // Modal de estadísticas de guardado
  const btnCloseStats = document.getElementById('close-modal-save-stats');
  if (btnCloseStats) btnCloseStats.addEventListener('click', () => closeModal('modal-save-stats-overlay'));
  const btnStatsClose = document.getElementById('btn-save-stats-close');
  if (btnStatsClose) btnStatsClose.addEventListener('click', () => closeModal('modal-save-stats-overlay'));
  const btnStatsDownload = document.getElementById('btn-save-stats-download');
  if (btnStatsDownload) btnStatsDownload.addEventListener('click', async () => {
    closeModal('modal-save-stats-overlay');
    await exportBundle();
  });

  // Inicializar menú hamburguesa y opciones móviles
  initMobileMenu();
}

/* ================================================================
   MENÚ HAMBURGUESA Y DRAWER MÓVIL
   ================================================================ */

function openMobileMenu() {
  updateMobileMenuUI();
  const overlay = document.getElementById('mobile-menu-overlay');
  if (overlay) overlay.classList.add('active');
}

function closeMobileMenu() {
  const overlay = document.getElementById('mobile-menu-overlay');
  if (overlay) overlay.classList.remove('active');
}

/* Muestra/oculta el backdrop semitransparente detrás de los paneles laterales en móvil/tablet */
function updatePanelBackdrop() {
  const backdrop = document.getElementById('panel-backdrop');
  if (!backdrop) return;
  const anyOpen = App.ui.sourcesPanelOpen || App.ui.telePanelOpen;
  // Solo mostrar backdrop cuando alguno está abierto Y la pantalla es menor a 900px
  if (anyOpen && window.innerWidth <= 900) {
    backdrop.classList.add('active');
  } else {
    backdrop.classList.remove('active');
  }
}

function updateMobileMenuUI() {
  // Estado de guardado
  const statusDot = document.getElementById('mob-status-dot');
  const statusText = document.getElementById('mob-save-status-text');
  const mainStatus = document.getElementById('save-status');
  const mainText = document.getElementById('save-status-text');
  if (statusText && mainText) {
    statusText.textContent = mainText.textContent || 'Guardado';
  }
  if (statusDot && mainStatus) {
    if (mainStatus.classList.contains('saving')) {
      statusDot.style.background = 'var(--warning)';
    } else if (mainStatus.classList.contains('unsaved') || mainStatus.classList.contains('error')) {
      statusDot.style.background = 'var(--danger)';
    } else {
      statusDot.style.background = 'var(--success)';
    }
  }

  // Conteo de palabras
  const mobWc = document.getElementById('mob-word-count-badge');
  const sbWc = document.getElementById('sb-word-count');
  if (mobWc && sbWc) {
    mobWc.textContent = sbWc.textContent;
  }

  // Paneles de fuentes, TOC y telemetría
  const badgeSources = document.getElementById('mob-badge-sources');
  const badgeToc = document.getElementById('mob-badge-toc');
  const badgeTele = document.getElementById('mob-badge-tele');
  const isSidebarOpen = App.ui.sourcesPanelOpen;

  if (badgeSources) {
    const isSourcesActive = isSidebarOpen && App.ui.activeSidebarTab === 'sources';
    badgeSources.textContent = isSourcesActive ? 'Abierto' : 'Oculto';
    badgeSources.style.color = isSourcesActive ? 'var(--accent)' : 'var(--text-secondary)';
  }
  if (badgeToc) {
    const isTocActive = isSidebarOpen && App.ui.activeSidebarTab === 'toc';
    badgeToc.textContent = isTocActive ? 'Abierto' : 'Oculto';
    badgeToc.style.color = isTocActive ? 'var(--accent)' : 'var(--text-secondary)';
  }
  if (badgeTele) {
    badgeTele.textContent = App.ui.telePanelOpen ? 'Abierto' : 'Oculto';
    badgeTele.style.color = App.ui.telePanelOpen ? 'var(--accent)' : 'var(--text-secondary)';
  }

  // Tema visual
  const isDark = App.ui.currentTheme === 'dark';
  const themeDesc = document.getElementById('mob-theme-desc');
  const themeBadge = document.getElementById('mob-theme-badge');
  if (themeDesc) themeDesc.textContent = isDark ? 'Modo Oscuro activo' : 'Modo Claro activo';
  if (themeBadge) themeBadge.textContent = isDark ? 'Claro ☀' : 'Oscuro 🌙';

  // Sonido
  const soundDesc = document.getElementById('mob-sound-desc');
  const soundBadge = document.getElementById('mob-sound-badge');
  if (soundDesc) soundDesc.textContent = SoundFx.enabled ? 'Sonidos activados (gamificación)' : 'Sonidos silenciados';
  if (soundBadge) {
    soundBadge.textContent = SoundFx.enabled ? 'Activado' : 'Silenciado';
    soundBadge.style.color = SoundFx.enabled ? 'var(--success)' : 'var(--text-muted)';
  }

  // Botón vincular carpeta
  const btnFolder = document.getElementById('mob-btn-folder');
  if (btnFolder) {
    btnFolder.style.display = ('showDirectoryPicker' in window) ? 'flex' : 'none';
  }
}

function initMobileMenu() {
  const btnHamburger = document.getElementById('btn-hamburger-menu');
  const btnClose = document.getElementById('close-mobile-menu');
  const overlay = document.getElementById('mobile-menu-overlay');

  if (btnHamburger) btnHamburger.addEventListener('click', openMobileMenu);
  if (btnClose) btnClose.addEventListener('click', closeMobileMenu);
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeMobileMenu();
    });
  }

  // Backdrop de paneles: cerrar al tocar fuera
  const panelBackdrop = document.getElementById('panel-backdrop');
  if (panelBackdrop) {
    panelBackdrop.addEventListener('click', () => {
      const sbSrc = document.getElementById('sidebar-sources');
      const sbTele = document.getElementById('sidebar-telemetry');
      App.ui.sourcesPanelOpen = false;
      App.ui.telePanelOpen = false;
      if (sbSrc) sbSrc.classList.add('collapsed');
      if (sbTele) sbTele.classList.add('collapsed');
      panelBackdrop.classList.remove('active');
      updateMobileMenuUI();
    });
  }

  // Vistas y Paneles
  const mobSources = document.getElementById('mob-btn-toggle-sources');
  if (mobSources) {
    mobSources.addEventListener('click', () => {
      toggleSourcesPanel();
      closeMobileMenu();
    });
  }

  const mobToc = document.getElementById('mob-btn-toggle-toc');
  if (mobToc) {
    mobToc.addEventListener('click', () => {
      toggleTocPanel();
      closeMobileMenu();
    });
  }

  const mobTele = document.getElementById('mob-btn-toggle-tele');
  if (mobTele) {
    mobTele.addEventListener('click', () => {
      toggleTelemetryPanel();
      closeMobileMenu();
    });
  }

  // Preferencias
  const mobTheme = document.getElementById('mob-btn-theme');
  if (mobTheme) {
    mobTheme.addEventListener('click', () => {
      applyTheme(App.ui.currentTheme === 'light' ? 'dark' : 'light');
    });
  }

  const mobSound = document.getElementById('mob-btn-sound');
  if (mobSound) {
    mobSound.addEventListener('click', () => {
      SoundFx.toggle();
    });
  }

  // Archivo y Guardado
  const mobSaveJson = document.getElementById('mob-btn-save-json');
  if (mobSaveJson) {
    mobSaveJson.addEventListener('click', async () => {
      closeMobileMenu();
      await exportBundle();
    });
  }

  // Guardar con estadísticas (móvil)
  const mobManualSave = document.getElementById('mob-btn-manual-save');
  if (mobManualSave) {
    mobManualSave.addEventListener('click', async () => {
      closeMobileMenu();
      await saveProjectWithStats();
    });
  }

  const mobOpenFile = document.getElementById('mob-btn-open-file');
  if (mobOpenFile) {
    mobOpenFile.addEventListener('click', () => {
      closeMobileMenu();
      openJsonFileDialog();
    });
  }

  const mobFolder = document.getElementById('mob-btn-folder');
  if (mobFolder) {
    mobFolder.addEventListener('click', () => {
      closeMobileMenu();
      openOrCreateProject('open');
    });
  }

  // Exportar manuscrito
  const mobExportPdf = document.getElementById('mob-btn-export-pdf');
  if (mobExportPdf) {
    mobExportPdf.addEventListener('click', () => {
      closeMobileMenu();
      exportToPDF();
    });
  }

  const mobExportDocx = document.getElementById('mob-btn-export-docx');
  if (mobExportDocx) {
    mobExportDocx.addEventListener('click', () => {
      closeMobileMenu();
      exportToDocx();
    });
  }

  const mobExportRis = document.getElementById('mob-btn-export-ris');
  if (mobExportRis) {
    mobExportRis.addEventListener('click', () => {
      closeMobileMenu();
      exportToRIS();
    });
  }
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

/* ================================================================
   MÓDULOS DE NUEVAS FUNCIONALIDADES:
   - Pestañas de Sidebar (Fuentes / Contenido TOC)
   - Indentación (Izquierda, Derecha, Ambas)
   - Tabla con Autoajuste y Wrapping Condicional
   - Tabla de Contenidos (TOC Navegable, Auto-actualizable, Insertable)
   - Bibliografía Insertable
   - División de Página Visible, Statusbar y Scroll Tooltip
   ================================================================ */

// ---- Pestañas del Sidebar Izquierdo ----
function switchSidebarTab(tabName) {
  App.ui.activeSidebarTab = tabName;
  const tabSources = document.getElementById('tab-btn-sources');
  const tabToc = document.getElementById('tab-btn-toc');
  const viewSources = document.getElementById('view-sources');
  const viewToc = document.getElementById('view-toc');

  if (tabName === 'toc') {
    if (tabToc) tabToc.classList.add('active');
    if (tabSources) tabSources.classList.remove('active');
    if (viewSources) {
      viewSources.classList.add('hidden');
      viewSources.style.display = 'none';
    }
    if (viewToc) {
      viewToc.classList.remove('hidden');
      viewToc.style.display = 'flex';
    }
    updateTableOfContents();
  } else {
    if (tabSources) tabSources.classList.add('active');
    if (tabToc) tabToc.classList.remove('active');
    if (viewToc) {
      viewToc.classList.add('hidden');
      viewToc.style.display = 'none';
    }
    if (viewSources) {
      viewSources.classList.remove('hidden');
      viewSources.style.display = 'flex';
    }
  }
  if (typeof updateMobileMenuUI === 'function') updateMobileMenuUI();
}
window.switchSidebarTab = switchSidebarTab;

function initSidebarTabs() {
  const tabSources = document.getElementById('tab-btn-sources');
  const tabToc = document.getElementById('tab-btn-toc');

  if (tabSources) {
    tabSources.addEventListener('click', (e) => {
      e.preventDefault();
      switchSidebarTab('sources');
    });
  }
  if (tabToc) {
    tabToc.addEventListener('click', (e) => {
      e.preventDefault();
      switchSidebarTab('toc');
    });
  }
}

// ---- Indentación ----
function applyIndentLeft() {
  if (!App.quill) return;
  const range = App.quill.getSelection(true);
  if (!range) return;
  const formats = App.quill.getFormat(range);
  const cur = parseInt(formats.indent || 0, 10);
  const next = cur >= 3 ? false : cur + 1;
  App.quill.format('indent', next, 'user');
  App.ui.isDirty = true;
  updateSaveStatus('unsaved');
}

function applyIndentRight() {
  if (!App.quill) return;
  const range = App.quill.getSelection(true);
  if (!range) return;
  const formats = App.quill.getFormat(range);
  const cur = parseInt(formats['indent-right'] || 0, 10);
  const next = cur >= 3 ? false : String(cur + 1);
  App.quill.format('indent-right', next, 'user');
  App.ui.isDirty = true;
  updateSaveStatus('unsaved');
}

function applyIndentBoth() {
  if (!App.quill) return;
  const range = App.quill.getSelection(true);
  if (!range) return;
  const formats = App.quill.getFormat(range);
  const cur = parseInt(formats['indent-both'] || 0, 10);
  const next = cur >= 3 ? false : String(cur + 1);
  App.quill.format('indent-both', next, 'user');
  App.ui.isDirty = true;
  updateSaveStatus('unsaved');
}

// ---- Tabla Académica ----
function openTableModal() {
  openModal('modal-table-overlay');
}
window.openTableModal = openTableModal;

function closeTableModal() {
  closeModal('modal-table-overlay');
}
window.closeTableModal = closeTableModal;

function insertTableAtCursor() {
  const rowsInput = document.getElementById('table-input-rows');
  const colsInput = document.getElementById('table-input-cols');
  const hasHeader = document.getElementById('table-input-has-header')?.checked ?? true;

  const rows = Math.max(1, Math.min(25, parseInt(rowsInput?.value || 3, 10)));
  const cols = Math.max(1, Math.min(10, parseInt(colsInput?.value || 3, 10)));

  let tableHtml = `<div class="academic-table-controls">
    <span><strong>Tabla</strong> (<span class="col-count">${cols}</span>×<span class="row-count">${rows}</span>)</span>
    <div class="btn-table-group">
      <button type="button" class="btn-table-action btn-add-row" title="Agregar fila al final">+ Fila</button>
      <button type="button" class="btn-table-action btn-add-col" title="Agregar columna a la derecha">+ Columna</button>
      <button type="button" class="btn-table-action btn-del-row" title="Eliminar última fila">- Fila</button>
      <button type="button" class="btn-table-action btn-del-col" title="Eliminar última columna">- Columna</button>
      <button type="button" class="btn-table-action danger btn-del-table" title="Eliminar esta tabla">✕ Eliminar</button>
    </div>
  </div>
  <table class="academic-table">`;

  for (let r = 0; r < rows; r++) {
    tableHtml += `<tr>`;
    for (let c = 0; c < cols; c++) {
      if (r === 0 && hasHeader) {
        tableHtml += `<th contenteditable="true">Encabezado ${c + 1}</th>`;
      } else {
        tableHtml += `<td contenteditable="true">Dato ${r + 1},${c + 1}</td>`;
      }
    }
    tableHtml += `</tr>`;
  }
  tableHtml += `</table>`;

  if (App.quill) {
    const range = App.quill.getSelection(true) || { index: App.quill.getLength(), length: 0 };
    runAsSystemInsert(() => App.quill.insertEmbed(range.index, 'academic-table', { html: tableHtml }, 'user'));
    App.quill.setSelection(range.index + 1, 0, 'silent');
    closeTableModal();
    showToast(`✓ Tabla de ${rows}×${cols} insertada.`, 'success');
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
    setTimeout(() => adjustAllTablesWrapping(), 80);
  }
}

function adjustTableWrapping(tableEl) {
  if (!tableEl) return;
  const container = document.getElementById('document-sheet') || tableEl.parentElement;
  if (!container) return;

  // Remueve primero el wrapping para medir el ancho natural requerido por las celdas
  tableEl.classList.remove('table-wrapped');

  // Ancho disponible en la hoja descontando padding interior
  const availableWidth = container.clientWidth - 130;

  // Si el ancho natural de la tabla excede los márgenes, se activa el wrapping
  if (tableEl.scrollWidth > availableWidth) {
    tableEl.classList.add('table-wrapped');
  } else {
    tableEl.classList.remove('table-wrapped');
  }
}

function adjustAllTablesWrapping() {
  const tables = document.querySelectorAll('.academic-table');
  tables.forEach(table => adjustTableWrapping(table));
}

function handleTableActionClick(e) {
  const btn = e.target.closest('.btn-table-action');
  if (!btn) return;

  const container = btn.closest('.academic-table-container');
  if (!container) return;
  const table = container.querySelector('.academic-table');
  if (!table) return;

  if (btn.classList.contains('btn-add-row')) {
    const rows = table.querySelectorAll('tr');
    const colsCount = rows[0] ? rows[0].children.length : 1;
    const newTr = document.createElement('tr');
    for (let c = 0; c < colsCount; c++) {
      const td = document.createElement('td');
      td.setAttribute('contenteditable', 'true');
      td.textContent = `Dato ${rows.length + 1},${c + 1}`;
      newTr.appendChild(td);
    }
    table.appendChild(newTr);
    updateTableRowColDisplay(container, table);
    adjustTableWrapping(table);
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
  } else if (btn.classList.contains('btn-add-col')) {
    const rows = table.querySelectorAll('tr');
    rows.forEach((tr, rIdx) => {
      const isTh = tr.children[0] && tr.children[0].tagName === 'TH';
      const cell = document.createElement(isTh ? 'th' : 'td');
      cell.setAttribute('contenteditable', 'true');
      cell.textContent = isTh ? `Encabezado ${tr.children.length + 1}` : `Dato ${rIdx + 1},${tr.children.length + 1}`;
      tr.appendChild(cell);
    });
    updateTableRowColDisplay(container, table);
    adjustTableWrapping(table);
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
  } else if (btn.classList.contains('btn-del-row')) {
    const rows = table.querySelectorAll('tr');
    if (rows.length > 1) {
      rows[rows.length - 1].remove();
      updateTableRowColDisplay(container, table);
      adjustTableWrapping(table);
      App.ui.isDirty = true;
      updateSaveStatus('unsaved');
    } else {
      showToast('La tabla debe conservar al menos 1 fila.', 'warning');
    }
  } else if (btn.classList.contains('btn-del-col')) {
    const rows = table.querySelectorAll('tr');
    if (rows[0] && rows[0].children.length > 1) {
      rows.forEach(tr => {
        if (tr.lastElementChild) tr.lastElementChild.remove();
      });
      updateTableRowColDisplay(container, table);
      adjustTableWrapping(table);
      App.ui.isDirty = true;
      updateSaveStatus('unsaved');
    } else {
      showToast('La tabla debe conservar al menos 1 columna.', 'warning');
    }
  } else if (btn.classList.contains('btn-del-table')) {
    if (confirm('¿Eliminar esta tabla por completo?')) {
      // Eliminar a través de Quill (antes se quitaba del DOM a sus espaldas y el
      // modelo interno del editor quedaba desincronizado al guardar o deshacer)
      const blot = Quill.find(container);
      if (blot && App.quill) {
        const index = App.quill.getIndex(blot);
        runAsSystemInsert(() => App.quill.deleteText(index, 1, 'user'));
      } else {
        container.remove();
      }
      App.ui.isDirty = true;
      updateSaveStatus('unsaved');
      showToast('Tabla eliminada.', 'info');
    }
  }
}

function updateTableRowColDisplay(container, table) {
  const rowSpan = container.querySelector('.row-count');
  const colSpan = container.querySelector('.col-count');
  const rows = table.querySelectorAll('tr');
  if (rowSpan) rowSpan.textContent = rows.length;
  if (colSpan && rows[0]) colSpan.textContent = rows[0].children.length;
}

// ---- Tabla de Contenidos (TOC) ----
let tocDebounceTimer = null;
function scheduleUpdateTOC() {
  clearTimeout(tocDebounceTimer);
  tocDebounceTimer = setTimeout(() => {
    updateTableOfContents();
  }, 250);
}

function getDocumentHeadings() {
  const editor = document.querySelector('#quill-editor .ql-editor');
  if (!editor) return [];

  const headings = [];
  const elements = editor.querySelectorAll('h1, h2, h3, h4, h5');
  elements.forEach((el, index) => {
    const text = el.textContent.trim();
    if (!text) return;
    const level = parseInt(el.tagName.replace('H', ''), 10);
    const id = `doc-heading-${index + 1}`;
    el.id = id;
    el.setAttribute('data-heading-idx', String(index));

    // Calcular página real (1056px por página)
    const elOffset = el.offsetTop;
    const pageNum = Math.max(1, Math.floor(elOffset / PAGE_HEIGHT) + 1);

    // Buscar el índice de carácter en Quill para selección directa
    let charIndex = null;
    try {
      const blot = Quill.find(el);
      if (blot && App.quill) {
        charIndex = App.quill.getIndex(blot);
      }
    } catch (e) {}

    headings.push({
      id,
      index,
      charIndex,
      level,
      text,
      pageNum,
      element: el
    });
  });
  return headings;
}

function updateTableOfContents() {
  const tocList = document.getElementById('toc-list');
  if (!tocList) return;

  const headings = getDocumentHeadings();
  if (headings.length === 0) {
    tocList.innerHTML = `
      <p class="text-sm text-muted" style="padding: 12px 6px; line-height: 1.5;">
        Aún no hay títulos en el documento. Usa el selector de encabezados (Título 1 a 5) en la barra superior para estructurar tu trabajo.
      </p>
    `;
    return;
  }

  let html = '';
  headings.forEach(h => {
    html += `
      <div class="toc-item toc-item-h${h.level}" data-heading-id="${h.id}" data-heading-idx="${h.index}" data-char-idx="${h.charIndex !== null ? h.charIndex : ''}" title="${escapeHtml(h.text)} (Pág. ${h.pageNum})">
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(h.text)}</span>
        <span class="toc-badge">P.${h.pageNum}</span>
      </div>
    `;
  });
  tocList.innerHTML = html;

  tocList.querySelectorAll('.toc-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const idx = parseInt(item.getAttribute('data-heading-idx'), 10);
      const rawCharIdx = item.getAttribute('data-char-idx');
      const charIdx = rawCharIdx !== '' ? parseInt(rawCharIdx, 10) : null;
      const editor = document.querySelector('#quill-editor .ql-editor');
      let targetEl = null;

      if (editor) {
        const elements = editor.querySelectorAll('h1, h2, h3, h4, h5');
        if (elements && elements[idx]) {
          targetEl = elements[idx];
        }
      }
      if (!targetEl) {
        const hId = item.getAttribute('data-heading-id');
        targetEl = document.getElementById(hId);
      }

      if (targetEl) {
        // 1. Cerrar panel móvil si estamos en pantalla pequeña (<= 900px)
        if (window.innerWidth <= 900) {
          const sb = document.getElementById('sidebar-sources');
          if (sb) {
            App.ui.sourcesPanelOpen = false;
            sb.classList.add('collapsed');
            updatePanelBackdrop();
          }
        }

        // 2. Colocar cursor en Quill en el título si se conoce el charIndex
        if (charIdx !== null && !isNaN(charIdx) && App.quill) {
          try {
            App.quill.setSelection(charIdx, 0, 'user');
          } catch (err) {}
        }

        // 3. Ejecutar scroll nativo garantizado y centrado
        const executeScroll = () => {
          try {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } catch (err) {
            targetEl.scrollIntoView(true);
          }

          const editorArea = document.getElementById('editor-area');
          if (editorArea) {
            const rect = targetEl.getBoundingClientRect();
            const areaRect = editorArea.getBoundingClientRect();
            const diff = (rect.top - areaRect.top) - (areaRect.height / 3);
            editorArea.scrollBy({ top: diff, behavior: 'smooth' });
          }

          targetEl.classList.remove('heading-nav-pulse');
          void targetEl.offsetWidth; // forzar reflow
          targetEl.classList.add('heading-nav-pulse');
        };

        executeScroll();
        // Segundo pase tras 100ms para asegurar que el reflow del cierre del panel no aborte el scroll
        setTimeout(executeScroll, 100);
      }
    });
  });
}
window.updateTableOfContents = updateTableOfContents;

function insertTableOfContentsIntoDoc() {
  const headings = getDocumentHeadings();
  if (headings.length === 0) {
    showToast('No se encontraron títulos en el documento para crear el índice.', 'warning');
    return;
  }

  let tocHtml = `<div class="doc-toc-block" contenteditable="false">`;
  tocHtml += `<h3>ÍNDICE GENERAL</h3>`;
  headings.forEach(h => {
    const indentPx = (h.level - 1) * 16;
    tocHtml += `
      <div class="doc-toc-row" style="padding-left: ${indentPx}px;">
        <span>${escapeHtml(h.text)}</span>
        <span class="doc-toc-dots"></span>
        <span class="doc-toc-page">Pág. ${h.pageNum}</span>
      </div>
    `;
  });
  tocHtml += `</div><p><br></p>`;

  if (App.quill) {
    const range = App.quill.getSelection(true) || { index: 0, length: 0 };
    runAsSystemInsert(() => App.quill.clipboard.dangerouslyPasteHTML(range.index, tocHtml, 'user'));
    showToast(`📋 Índice general insertado con ${headings.length} secciones.`, 'success');
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
  }
}

// ---- Bibliografía Insertable ----
/** Estilo de la bibliografía: el elegido para el proyecto o el más usado en las fuentes. */
function projectCitationStyle() {
  if (App.project.metadata.citation_style) return App.project.metadata.citation_style;
  const counts = {};
  (App.project.sources || []).forEach(s => {
    const st = s.citation_style || 'chicago-note';
    counts[st] = (counts[st] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'chicago-note';
}

function insertBibliographyIntoDoc() {
  const sources = App.project.sources || [];
  if (sources.length === 0) {
    showToast('No hay fuentes registradas para generar la bibliografía. Agrégalas en el panel izquierdo.', 'warning');
    return;
  }

  // Orden alfabético por apellido del primer autor (o por título)
  const sorted = [...sources].sort((a, b) => {
    const ka = a.authors?.[0] ? normalizeAuthorName(a.authors[0]).lastName : (a.title || '');
    const kb = b.authors?.[0] ? normalizeAuthorName(b.authors[0]).lastName : (b.title || '');
    return ka.localeCompare(kb, 'es', { sensitivity: 'base' });
  });

  const style = projectCitationStyle();
  const heading = style === 'apa' ? 'Referencias' : style === 'mla' ? 'Obras citadas' : 'Bibliografía';

  let bibHtml = `<h2>${heading}</h2>`;
  sorted.forEach(src => {
    bibHtml += `<p class="bibliography-entry">${formatBibliographyEntry(src, style)}</p>`;
  });
  bibHtml += `<p><br></p>`;

  if (App.quill) {
    const length = App.quill.getLength();
    runAsSystemInsert(() => App.quill.clipboard.dangerouslyPasteHTML(length, bibHtml, 'user'));
    const label = { 'chicago-note': 'Chicago', 'chicago-author-date': 'Chicago autor-fecha', apa: 'APA 7', mla: 'MLA 9' }[style] || style;
    showToast(`📚 ${heading} (${label}) con ${sorted.length} fuentes insertada al final del documento.`, 'success');
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
  }
}

function formatBibliographyEntry(src, style) {
  const authors = src.authors || [];
  const year    = src.year || 's. f.';
  const title   = escapeHtml(src.title || 'Sin título');
  const journal = escapeHtml(src.journal || '');
  const pages   = escapeHtml((src.pages || '').replace(/--/g, '–'));
  const doiRaw  = (src.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
  const doi     = doiRaw ? (/^https?:/.test(doiRaw) ? ` ${escapeHtml(doiRaw)}` : ` https://doi.org/${escapeHtml(doiRaw)}`) : '';
  const names   = authors.map(normalizeAuthorName);
  const isJournal = src.type === 'journal';

  if (style === 'apa') {
    // Apellido, I. I., Apellido, I., & Apellido, I. (Año). Título. Revista, pp. DOI
    const initials = n => n.firstName ? n.firstName.split(/[\s-]+/).filter(Boolean).map(w => w[0].toUpperCase() + '.').join(' ') : '';
    const list = names.map(n => initials(n) ? `${n.lastName}, ${initials(n)}` : n.lastName);
    const authorStr = list.length === 0 ? title
      : list.length === 1 ? list[0]
      : list.slice(0, -1).join(', ') + ', & ' + list[list.length - 1];
    if (isJournal) return `${escapeHtml(authorStr)} (${year}). ${title}. <em>${journal}</em>${pages ? `, ${pages}` : ''}.${doi}`;
    return `${escapeHtml(authorStr)} (${year}). <em>${title}</em>.${doi}`;
  }

  // Primer autor invertido, resto en orden natural (Chicago y MLA)
  const invFirst = names.map((n, i) => i === 0
    ? (n.firstName ? `${n.lastName}, ${n.firstName}` : n.lastName)
    : (n.firstName ? `${n.firstName} ${n.lastName}` : n.lastName));
  const joinAuthors = (arr) => arr.length <= 1 ? (arr[0] || '')
    : arr.length === 2 ? `${arr[0]} y ${arr[1]}`
    : `${arr.slice(0, -1).join(', ')} y ${arr[arr.length - 1]}`;

  if (style === 'mla') {
    // Apellido, Nombre, et al. "Título." Revista, Año, pp. DOI.
    const authorStr = names.length === 0 ? '' : names.length > 2 ? `${invFirst[0]}, et al` : joinAuthors(invFirst);
    if (isJournal) return `${escapeHtml(authorStr)}. "${title}." <em>${journal}</em>, ${year}${pages ? `, pp. ${pages}` : ''}.${doi}`;
    return `${escapeHtml(authorStr)}. <em>${title}</em>. ${year}.${doi}`;
  }

  const authorStr = names.length ? joinAuthors(invFirst) : 'Autor desconocido';
  if (style === 'chicago-author-date') {
    // Apellido, Nombre. Año. "Título." Revista pp. DOI.
    if (isJournal) return `${escapeHtml(authorStr)}. ${year}. "${title}." <em>${journal}</em>${pages ? `: ${pages}` : ''}.${doi}`;
    return `${escapeHtml(authorStr)}. ${year}. <em>${title}</em>.${doi}`;
  }
  // Chicago notas y bibliografía: Apellido, Nombre. "Título." Revista (Año): pp. DOI.
  if (isJournal) return `${escapeHtml(authorStr)}. "${title}." <em>${journal}</em> (${year})${pages ? `: ${pages}` : ''}.${doi}`;
  return `${escapeHtml(authorStr)}. <em>${title}</em>. ${year}.${doi}`;
}

// ---- División de Página Visible, Statusbar y Scroll Tooltip ----
const PAGE_HEIGHT = 1056; // Altura estándar de página Carta/A4 a 96dpi

function updatePageMetrics(fromScroll = false) {
  const editorArea = document.getElementById('editor-area');
  const sheet = document.getElementById('document-sheet');
  const editor = document.querySelector('#quill-editor .ql-editor');
  if (!editorArea || !sheet) return;

  // Medir altura real del contenido editado y calcular páginas completas necesarias
  const contentHeight = editor ? Math.max(editor.scrollHeight, editor.offsetHeight, 600) : 600;
  const totalPages = Math.max(1, Math.ceil(contentHeight / PAGE_HEIGHT));

  // Asegurar que el lienzo del documento tenga la altura suficiente para contener todas las páginas
  sheet.style.minHeight = `${totalPages * PAGE_HEIGHT}px`;

  // Actualizar líneas visibles de corte de página
  updateVisiblePageBreaks(totalPages);

  // Si proviene de interacción con scroll o se requiere tooltip flotante
  if (fromScroll) {
    const scrollTop = editorArea.scrollTop;
    const viewMiddle = scrollTop + (editorArea.clientHeight / 3);
    const currentPage = Math.min(totalPages, Math.max(1, Math.floor(viewMiddle / PAGE_HEIGHT) + 1));
    showScrollPageTooltip(currentPage, totalPages);
  }
}

function updateVisiblePageBreaks(totalPages) {
  const sheet = document.getElementById('document-sheet');
  if (!sheet) return;

  const existingBreaks = sheet.querySelectorAll('.page-break-line');
  if (existingBreaks.length === (totalPages - 1)) return; // ya sincronizado

  existingBreaks.forEach(b => b.remove());
  for (let p = 2; p <= totalPages; p++) {
    const breakEl = document.createElement('div');
    breakEl.className = 'page-break-line';
    breakEl.style.top = `${(p - 1) * PAGE_HEIGHT}px`;
    breakEl.innerHTML = `<span class="page-break-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Fin de Página ${p - 1} &nbsp;·&nbsp; Página ${p}</span>`;
    sheet.appendChild(breakEl);
  }
}

let tooltipHideTimer = null;
function showScrollPageTooltip(currentPage, totalPages) {
  const tooltip = document.getElementById('scroll-page-tooltip');
  const editorArea = document.getElementById('editor-area');
  if (!tooltip || !editorArea) return;

  const maxScroll = editorArea.scrollHeight - editorArea.clientHeight;
  const ratio = maxScroll > 0 ? (editorArea.scrollTop / maxScroll) : 0;
  const clientH = editorArea.clientHeight;
  const topPx = Math.max(70, Math.min(clientH - 60, ratio * (clientH - 120) + 70));

  tooltip.style.top = `${topPx}px`;
  tooltip.textContent = `Pág. ${currentPage} de ${totalPages}`;
  tooltip.classList.add('visible');

  clearTimeout(tooltipHideTimer);
  tooltipHideTimer = setTimeout(() => {
    tooltip.classList.remove('visible');
  }, 1200);
}

// ---- Indicador de Posición del Cursor en Barra de Estado (Línea X de Pág. Y) ----
function updateCursorPosition() {
  const indicator = document.getElementById('sb-cursor-pos-indicator');
  if (!indicator) return;

  if (!App.quill) {
    indicator.textContent = 'Línea 1 de Pág. 1';
    return;
  }

  const range = App.quill.getSelection();
  if (!range) return;

  try {
    const editor = document.querySelector('#quill-editor .ql-editor');
    if (!editor) return;

    // 1. Obtener la línea/bloque de Quill donde se ubica el cursor
    const [currentBlot] = App.quill.getLine(range.index);
    const currentDom = currentBlot ? currentBlot.domNode : null;

    // 2. Obtener la posición vertical exacta mediante bounds o DOM
    const bounds = App.quill.getBounds(range.index);
    const cursorTop = bounds ? Math.max(0, bounds.top) : (currentDom ? currentDom.offsetTop : 0);

    // 3. Determinar la página actual con base en PAGE_HEIGHT (1056px)
    const cursorPage = Math.max(1, Math.floor(cursorTop / PAGE_HEIGHT) + 1);

    // 4. Calcular el número de línea exacto dentro de la página actual
    const pageTop = (cursorPage - 1) * PAGE_HEIGHT;
    const pageBottom = cursorPage * PAGE_HEIGHT;

    let lineInPage = 1;
    const blocks = Array.from(editor.querySelectorAll('p, h1, h2, h3, h4, h5, li, blockquote, pre, tr'));

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const bTop = b.offsetTop;
      const bHeight = b.offsetHeight || 28;

      // Si el bloque finaliza antes del inicio de esta página, saltarlo
      if ((bTop + bHeight) <= pageTop) continue;

      // Si el bloque comienza en la página siguiente, terminar conteo
      if (bTop >= pageBottom) break;

      // Si alcanzamos el bloque donde está el cursor
      if (b === currentDom || b.contains(currentDom)) {
        // En caso de que el párrafo tenga múltiples líneas envueltas (wrapped text)
        const innerOffset = Math.max(0, cursorTop - bTop);
        const innerLines = Math.floor(innerOffset / 28);
        lineInPage += innerLines;
        break;
      }

      // Estimar cuántas líneas visuales ocupa este bloque previo en la página
      const blockLineCount = Math.max(1, Math.round(bHeight / 28));
      lineInPage += blockLineCount;
    }

    indicator.textContent = `Línea ${lineInPage} de Pág. ${cursorPage}`;
  } catch (err) {
    console.warn('Error calculating cursor position:', err);
  }
}
window.updateCursorPosition = updateCursorPosition;



// Funciones usadas desde atributos onclick del HTML
window.relinkCaptureInteractive = relinkCaptureInteractive;
window.viewScreenshot = viewScreenshot;
