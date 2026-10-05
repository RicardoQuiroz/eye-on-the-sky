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
          loadProjectFromParsedJSON(parsed, name).catch(() => {});
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
  });

  // Telemetría: detectar texto tecleado vs pegado
  App.quill.on('text-change', (delta, oldDelta, source) => {
    if (source !== 'user') return;
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');

    const text       = App.quill.getText();
    const currentWC  = countWords(text);
    const wordDiff   = Math.max(0, currentWC - App.session.previousWordCount);

    if (wordDiff > 0) {
      if (App.session.isPasting) {
        // Ignorar palabras insertadas durante un evento de pegado capturado
      } else if (wordDiff >= 10) {
        // Inserción masiva súbita no capturada por evento DOM paste (ej: móviles Android/iOS o drag & drop)
        const isInitial = isProjectInitialPaste();
        const approxChars = wordDiff * 5;
        const pasteRecord = {
          timestamp:    new Date().toISOString(),
          chars_pasted: approxChars,
          approx_words: wordDiff,
          is_initial:   isInitial,
        };
        App.session.paste_events.push(pasteRecord);
        if (isInitial) {
          App.project.has_initial_paste = true;
          showToast('📋 Pegado inicial detectado y registrado como material base exento (0 penalización).', 'info');
        } else {
          App.session.chars_pasted += approxChars;
          SoundFx.play('paste_alert');
        }
      } else {
        // Escritura manual genuina (< 10 palabras en un solo micro-cambio)
        App.session.words_typed += wordDiff;
      }
    }

    // Hitos de palabras para gamificación (100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000)
    const milestones = [100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 5000];
    for (const m of milestones) {
      if (currentWC >= m && !App.session.passedMilestones.has(m)) {
        App.session.passedMilestones.add(m);
        if (!App.session.isPasting && wordDiff < 10) {
          SoundFx.play('milestone_words');
          showToast(`🎯 ¡Hito alcanzado: ${m} palabras escritas!`, 'success');
        }
      }
    }

    App.session.previousWordCount = currentWC;
    updateWordCount(currentWC);
    updateTelemetryUI();

    // Actualizar TOC, cálculo de páginas, posición de cursor y tablas
    scheduleUpdateTOC();
    updatePageMetrics();
    updateCursorPosition();
    adjustAllTablesWrapping();

    // Bug fix: limpiar formato 'background' activo si el usuario está escribiendo
    // manualmente (no pegando), para que el color de procedencia no se propague
    if (!App.session.isPasting && source === 'user') {
      // Solo limpiar si el delta insertado es texto puro (una letra a la vez)
      const ops = delta.ops || [];
      const hasInsert = ops.some(op => typeof op.insert === 'string' && op.insert.length <= 3);
      if (hasInsert) {
        // Verificar si el cursor tiene formato background activo y limpiarlo
        const range = App.quill.getSelection();
        if (range) {
          const format = App.quill.getFormat(range.index > 0 ? range.index - 1 : 0, 1);
          if (format.background && format.background !== false) {
            // No limpiar citas (morado) ni pegado inicial (azul), solo texto ya escrito
            // que heredó el color rojo del paste anterior
            const isRedish = format.background && format.background.includes('229, 57, 53');
            if (isRedish) {
              App.quill.formatText(range.index - 1, 1, 'background', false, 'silent');
            }
          }
        }
      }
    }
  });

  // Seguimiento de posición de cursor en tiempo real (Línea X de Pág. Y)
  App.quill.on('selection-change', (range, oldRange, source) => {
    updateCursorPosition();
  });

  // Activar corrector ortográfico nativo del navegador en español y eventos biométricos
  const editorEl = document.querySelector('#quill-editor .ql-editor');
  if (editorEl) {
    editorEl.setAttribute('spellcheck', 'true');
    editorEl.setAttribute('lang', 'es');
    editorEl.setAttribute('autocorrect', 'on');
    editorEl.addEventListener('paste', handlePasteEvent);
    editorEl.addEventListener('keydown', handleKeystrokeEvent);
    editorEl.addEventListener('keyup', (e) => {
      handleKeyUpEvent(e);
      updateCursorPosition();
    });
    editorEl.addEventListener('input', (e) => {
      scheduleUpdateTOC();
      updatePageMetrics();
      updateCursorPosition();
      const table = e.target.closest('.academic-table');
      if (table) {
        adjustTableWrapping(table);
        App.ui.isDirty = true;
        updateSaveStatus('unsaved');
      }
    });
    editorEl.addEventListener('click', (e) => {
      handleTableActionClick(e);
      updateCursorPosition();
    });
  }
}

/* ================================================================
   TELEMETRÍA
   ================================================================ */

function isProjectInitialPaste() {
  // 1. Si el proyecto ya tiene registrado un pegado inicial
  if (App.project.has_initial_paste) return false;

  // 2. Si alguna sesión previa en el historial ya contiene un pegado inicial
  const sessions = App.project.telemetry?.sessions || [];
  const hadInitial = sessions.some(s => (s.paste_events || []).some(p => p.is_initial));
  if (hadInitial) {
    App.project.has_initial_paste = true;
    return false;
  }

  // 3. Si en la sesión activa ya se registró un pegado inicial
  if ((App.session.paste_events || []).some(p => p.is_initial)) {
    return false;
  }

  // 4. Si el proyecto ya tiene más de 1 sesión consolidada o >100 palabras previas escritas
  const totalPrevTyped = sessions.reduce((sum, s) => sum + (s.words_typed || 0), 0);
  if (sessions.length > 1 || totalPrevTyped > 100) {
    return false;
  }

  // 5. Si el documento actual ya tiene más de 120 palabras antes del pegado
  const currentWC = App.quill ? countWords(App.quill.getText()) : 0;
  if (currentWC > 120) {
    return false;
  }

  // Es el primer pegado masivo del documento (completamente exento)
  return true;
}

function handlePasteEvent(e) {
  const clipText = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  const chars = clipText.length;
  if (chars < 10) return; // ignora pegados triviales

  // Determinar si es el primer pegado masivo del documento
  const isInitialPaste = isProjectInitialPaste();
  const range = App.quill ? App.quill.getSelection() : null;
  const pasteIndex = (range && typeof range.index === 'number') ? range.index : 0;

  // Activar flag para que text-change no cuente estas palabras como manuales
  App.session.isPasting = true;
  setTimeout(() => {
    App.session.isPasting = false;
    // Aplicar color de procedencia en Quill según el tipo de pegado
    if (App.quill && chars > 0) {
      const bgColor = isInitialPaste ? 'rgba(74, 108, 247, 0.16)' : 'rgba(229, 57, 53, 0.18)';
      // Calcular cuántos caracteres se insertaron realmente dentro de límites válidos
      const currentLen = App.quill.getLength();
      const safeIndex = Math.min(Math.max(0, pasteIndex), currentLen - 1);
      const insertedChars = Math.min(chars, Math.max(0, currentLen - safeIndex - 1));
      if (insertedChars > 0) {
        App.quill.formatText(safeIndex, insertedChars, 'background', bgColor, 'silent');
      }
      // CRÍTICO: Limpiar el formato activo del cursor para que el texto
      // que se escriba a continuación NO herede el color del paste
      App.quill.removeFormat(App.quill.getLength() - 1, 1);
      // Forzar que el cursor no tenga formato background activo
      const sel = App.quill.getSelection();
      if (sel) {
        App.quill.formatText(sel.index, 0, 'background', false, 'silent');
      }
    }
  }, 120);

  const approxWords = Math.round(chars / 5);

  const pasteRecord = {
    timestamp:    new Date().toISOString(),
    chars_pasted: chars,
    approx_words: approxWords,
    is_initial:   isInitialPaste,
  };

  App.session.paste_events.push(pasteRecord);

  if (isInitialPaste) {
    App.project.has_initial_paste = true;
    // CRÍTICO: No sumar a App.session.chars_pasted para no distorsionar estadísticas
    showToast('📋 Pegado inicial de material base registrado (exento de penalización en estadísticas).', 'info');
  } else {
    // Solo penalizar pastes que no son el inicial
    App.session.chars_pasted += chars;
    SoundFx.play('paste_alert');
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
  if (App.session.timer_ref) {
    clearInterval(App.session.timer_ref);
    App.session.timer_ref = null;
  }
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

async function createNewProjectDirectly() {
  resetSessionTimers();
  App.dirHandle = null;
  App.capturasHandle = null;

  // Inicializar metadatos del proyecto
  App.project.metadata.created_at = new Date().toISOString();
  App.project.metadata.title = 'Sin título';
  const titleInput = document.getElementById('doc-title-input');
  if (titleInput) titleInput.value = '';

  if (App.quill) {
    App.quill.setText('');
  }

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

  initSessionTimer();
  updateTelemetryUI();
  BiometricsEngine.updateUI();
}

async function createNewProject(dirHandle) {
  resetSessionTimers();
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
  resetSessionTimers();
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
    const titleInput = document.getElementById('doc-title-input');
    if (titleInput) {
      titleInput.value = App.project.metadata.title || '';
      // Actualizar el título de la pestaña del navegador
      document.title = `${titleInput.value || 'Sin título'} — Eye on the Sky`;
    }

    // Cargar fuentes en el panel
    renderSourcesList();
    updateTableOfContents();
    updatePageMetrics();
    setTimeout(() => adjustAllTablesWrapping(), 120);

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

  resetSessionTimers();

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

  // Detectar si el proyecto importado ya tiene pegado inicial
  if (App.project.has_initial_paste === undefined) {
    App.project.has_initial_paste = (App.project.telemetry?.sessions || []).some(s => 
      (s.paste_events || []).some(p => p.is_initial)
    );
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
  updateTableOfContents();
  updatePageMetrics();
  setTimeout(() => adjustAllTablesWrapping(), 120);

  const currentWC = countWords(App.quill ? App.quill.getText() : '');
  updateWordCount(currentWC);
  startProjectSession();

  App.ui.projectLoaded = true;

  const sbName = document.getElementById('sb-project-name');
  if (sbName) sbName.textContent = sourceName;
  // El botón con el ícono de carpeta muestra siempre el nombre de la carpeta elegida, nunca el archivo JSON
  updateFolderButtonUI();

  // Iniciar autoguardado periódico para que la sesión mantenga guardado automático (móvil y PC)
  startAutosave();

  // Guardar inmediatamente con firma criptográfica válida
  await saveProject();

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
    try {
      return structuredClone(obj);
    } catch (e) {
      // Ignorar fallback
    }
  }
  return JSON.parse(JSON.stringify(obj));
}

/* ================================================================
   AUTOGUARDADO
   ================================================================ */

function startAutosave() {
  if (App.session.autosave_ref) clearInterval(App.session.autosave_ref);
  App.session.autosave_ref = setInterval(async () => {
    if (!App.ui.isDirty) return;
    await saveProject();
  }, 15_000); // cada 15 segundos continuo (en disco o localStorage)
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

    // Asegurar que chars_pasted de la sesión solo contabilice eventos NO iniciales
    const nonInitialSessionChars = (App.session.paste_events || [])
      .filter(ev => !ev.is_initial)
      .reduce((sum, ev) => sum + (ev.chars_pasted || 0), 0);
    App.session.chars_pasted = nonInitialSessionChars;

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
      chars_pasted:       nonInitialSessionChars,
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

    // Sumar ÚNICAMENTE caracteres de eventos no iniciales
    const totalCharsPasted = allSessions.reduce((sum, s) => {
      const sChars = (s.paste_events || [])
        .filter(ev => !ev.is_initial)
        .reduce((pSum, ev) => pSum + (ev.chars_pasted || 0), 0);
      return sum + sChars;
    }, 0);

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
    const payload = safeClone(App.project);

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
   GUARDADO MANUAL CON MODAL DE ESTADÍSTICAS
   ================================================================ */

async function saveProjectWithStats() {
  await saveProject();

  // Poblar modal de estadísticas
  const titleInput = document.getElementById('doc-title-input');
  const docTitle = (titleInput && titleInput.value.trim()) || App.project.metadata?.title || 'Sin título';
  const lastSaved = App.project.metadata?.last_saved;

  const elTitle = document.getElementById('stats-doc-title');
  const elSavedAt = document.getElementById('stats-doc-saved-at');
  const elWords = document.getElementById('stats-word-count');
  const elTyped = document.getElementById('stats-words-typed');
  const elRatio = document.getElementById('stats-manual-ratio');
  const elTime = document.getElementById('stats-session-time');
  const elSources = document.getElementById('stats-sources-count');
  const elPaste = document.getElementById('stats-paste-events');
  const elSize = document.getElementById('stats-json-size');

  if (elTitle) elTitle.textContent = docTitle;
  if (elSavedAt && lastSaved) {
    elSavedAt.textContent = `Guardado: ${new Date(lastSaved).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' })}`;
  }

  const currentWC = countWords(App.quill ? App.quill.getText() : '');
  if (elWords) elWords.textContent = currentWC.toLocaleString('es');
  if (elTyped) elTyped.textContent = App.session.words_typed.toLocaleString('es');

  const penalizedWords = App.session.paste_events
    .filter(ev => !ev.is_initial)
    .reduce((sum, ev) => sum + (ev.approx_words || 0), 0);
  const total = App.session.words_typed + penalizedWords;
  const ratio = total > 0 ? Math.round((App.session.words_typed / total) * 100) : 100;
  if (elRatio) elRatio.textContent = `${ratio}%`;

  const sbTimer = document.getElementById('sb-session-time');
  if (elTime && sbTimer) {
    elTime.textContent = sbTimer.textContent.replace('Sesión: ', '');
  }

  if (elSources) elSources.textContent = (App.project.sources || []).length;
  if (elPaste) elPaste.textContent = App.session.paste_events.filter(ev => !ev.is_initial).length;

  // Calcular tamaño del JSON en localStorage
  try {
    const stored = localStorage.getItem('eots_active_project') || '';
    const bytes = new Blob([stored]).size;
    let sizeStr;
    if (bytes < 1024) sizeStr = `${bytes} B`;
    else if (bytes < 1024 * 1024) sizeStr = `${(bytes / 1024).toFixed(1)} KB`;
    else sizeStr = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    if (elSize) elSize.textContent = sizeStr;
  } catch (e) {
    if (elSize) elSize.textContent = '—';
  }

  SoundFx.play('autosave_peace');
  openModal('modal-save-stats-overlay');
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
  const countBadge = document.getElementById('sources-count-badge');
  if (countBadge) countBadge.textContent = App.project.sources.length;

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

function formatCitation(src, pages, style) {
  const authors = src.authors || [];
  const year    = src.year || 's. f.';
  const title   = src.title || '';
  const journal = src.journal || '';
  const pg      = pages ? (`, ${pages}`) : '';

  if (style === 'chicago-note' || style === 'chicago-author-date') {
    // Chicago nota completa
    const authorStr = authors.length > 0
      ? authors.map((a, i) => {
          const norm = normalizeAuthorName(a);
          if (i === 0) {
            return norm.firstName ? `${norm.lastName}, ${norm.firstName}` : norm.lastName;
          }
          return norm.firstName ? `${norm.firstName} ${norm.lastName}` : norm.lastName;
        }).join(', ')
      : 'Autor desconocido';
    if (src.type === 'journal') {
      return `${authorStr}, "${title}," <em>${journal}</em> (${year})${pg}.`;
    }
    return `${authorStr}, <em>${title}</em> (${year})${pg}.`;
  }

  if (style === 'apa') {
    let authorStr = 'Anónimo';
    if (authors.length === 1) {
      const n = normalizeAuthorName(authors[0]);
      authorStr = n.lastName;
    } else if (authors.length === 2) {
      const n1 = normalizeAuthorName(authors[0]);
      const n2 = normalizeAuthorName(authors[1]);
      authorStr = `${n1.lastName} & ${n2.lastName}`;
    } else if (authors.length > 2) {
      const n1 = normalizeAuthorName(authors[0]);
      authorStr = `${n1.lastName} et al.`;
    }
    return `(${authorStr}, ${year}${pg})`;
  }

  if (style === 'mla') {
    const firstAuthor = authors[0] ? normalizeAuthorName(authors[0]).lastName : 'Anón.';
    return `(${firstAuthor} ${pg.replace(', ','')})`.replace('  ', ' ');
  }

  const defaultAuthor = authors[0] ? normalizeAuthorName(authors[0]).lastName : 'Anón.';
  return `(${defaultAuthor}, ${year}${pg})`;
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
  App.quill.insertText(insertIndex, citation, 'user');
  App.quill.formatText(insertIndex, citation.length, 'background', 'rgba(139, 92, 246, 0.20)');
  App.quill.setSelection(insertIndex + citation.length);

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
  // Crear un input temporal para seleccionar imagen (funciona tanto en PC con carpeta como en móviles)
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
    const ext = ((file.name || 'captura.png').split('.').pop() || 'png').toLowerCase();
    const filename = `captura_${Date.now()}.${ext}`;

    // Si hay acceso a disco (PC con carpeta abierta), guardar físicamente en capturas/
    if (App.capturasHandle) {
      try {
        const fh = await App.capturasHandle.getFileHandle(filename, { create: true });
        const wr = await fh.createWritable();
        await wr.write(file);
        await wr.close();
      } catch (fsErr) {
        console.warn('No se pudo guardar archivo físico en capturas/:', fsErr);
      }
    }

    // Insertar marcador en el editor en la posición del cursor de forma protegida
    const range = (App.quill && App.quill.getSelection()) || { index: Math.max(0, (App.quill ? App.quill.getLength() : 1) - 1) };
    const insertIndex = (range && typeof range.index === 'number') ? range.index : Math.max(0, (App.quill ? App.quill.getLength() : 1) - 1);
    const placeholder = `[📸 Captura: ${filename}]`;
    App.quill.insertText(insertIndex, placeholder, { bold: false, italic: true, color: '#4a6cf7' }, 'user');

    // Guardar referencia persistente en el proyecto SIN blob_url efímero
    if (!App.project.inline_screenshots) App.project.inline_screenshots = {};
    App.project.inline_screenshots[placeholder] = {
      filename,
      inserted_at: new Date().toISOString(),
      size: file.size || 0,
      mime_type: file.type || 'image/png'
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

  showToast('Generando documento Word…', 'info');

  const { Document, Paragraph, TextRun, HeadingLevel, Packer, AlignmentType } = window.docx;

  const title = App.project.metadata.title || 'Sin título';
  const delta = App.quill ? App.quill.getContents() : null;
  const paragraphs = [];

  if (delta && Array.isArray(delta.ops)) {
    let currentRuns = [];
    delta.ops.forEach(op => {
      if (typeof op.insert === 'string') {
        const parts = op.insert.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (parts[i].length > 0) {
            currentRuns.push(new TextRun({
              text: parts[i],
              bold: !!op.attributes?.bold,
              italics: !!op.attributes?.italic,
              underline: !!op.attributes?.underline ? {} : undefined,
            }));
          }
          if (i < parts.length - 1) {
            let align = AlignmentType.LEFT;
            if (op.attributes?.align === 'center') align = AlignmentType.CENTER;
            else if (op.attributes?.align === 'right') align = AlignmentType.RIGHT;
            else if (op.attributes?.align === 'justify') align = AlignmentType.JUSTIFIED;

            let heading = undefined;
            if (op.attributes?.header === 1) heading = HeadingLevel.HEADING_1;
            else if (op.attributes?.header === 2) heading = HeadingLevel.HEADING_2;
            else if (op.attributes?.header === 3) heading = HeadingLevel.HEADING_3;
            else if (op.attributes?.header === 4) heading = HeadingLevel.HEADING_4;
            else if (op.attributes?.header === 5) heading = HeadingLevel.HEADING_5;

            paragraphs.push(new Paragraph({
              children: currentRuns.length > 0 ? currentRuns : [new TextRun('')],
              alignment: align,
              heading: heading,
              spacing: { after: 180, line: 276 }
            }));
            currentRuns = [];
          }
        }
      }
    });
    if (currentRuns.length > 0) {
      paragraphs.push(new Paragraph({
        children: currentRuns,
        spacing: { after: 180, line: 276 }
      }));
    }
  } else {
    const rawLines = (App.quill ? App.quill.getText() : '').split('\n').filter(l => l.trim());
    rawLines.forEach(l => {
      paragraphs.push(new Paragraph({ children: [new TextRun(l)], spacing: { after: 180 } }));
    });
  }

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
  const payload = safeClone(App.project);
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
      ['modal-source-overlay','modal-citation-overlay','modal-biometrics-overlay','modal-save-stats-overlay','modal-table-overlay'].forEach(id => closeModal(id));
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
    await exportJSON();
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
      await exportJSON();
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
    App.quill.insertEmbed(range.index, 'academic-table', { html: tableHtml }, 'user');
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
      container.remove();
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
    App.quill.clipboard.dangerouslyPasteHTML(range.index, tocHtml, 'user');
    showToast(`📋 Índice general insertado con ${headings.length} secciones.`, 'success');
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
  }
}

// ---- Bibliografía Insertable ----
function insertBibliographyIntoDoc() {
  const sources = App.project.sources || [];
  if (sources.length === 0) {
    showToast('No hay fuentes registradas para generar la bibliografía. Agrégalas en el panel izquierdo.', 'warning');
    return;
  }

  // Ordenar alfabéticamente por apellido del primer autor o título
  const sorted = [...sources].sort((a, b) => {
    const authorA = (a.authors && a.authors[0]) ? a.authors[0].toLowerCase() : (a.title || '').toLowerCase();
    const authorB = (b.authors && b.authors[0]) ? b.authors[0].toLowerCase() : (b.title || '').toLowerCase();
    return authorA.localeCompare(authorB);
  });

  const style = App.project.metadata.citation_style || 'chicago-note';

  let bibHtml = `<div class="doc-bib-block"><h2>Bibliografía</h2>`;
  sorted.forEach(src => {
    const entryText = formatBibliographyEntry(src, style);
    bibHtml += `<p class="bibliography-entry">${entryText}</p>`;
  });
  bibHtml += `</div><p><br></p>`;

  if (App.quill) {
    const length = App.quill.getLength();
    App.quill.clipboard.dangerouslyPasteHTML(length, bibHtml, 'user');
    showToast(`📚 Bibliografía con ${sorted.length} fuentes insertada al final del documento.`, 'success');
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
  }
}

function formatBibliographyEntry(src, style) {
  const authors = src.authors || [];
  const year    = src.year || 's. f.';
  const title   = src.title || 'Sin título';
  const journal = src.journal || '';
  const doi     = src.doi ? ` https://doi.org/${src.doi.replace(/^https?:\/\/doi\.org\//, '')}` : '';

  if (style === 'apa') {
    const authorStr = authors.length > 0 ? authors.join(', ') : 'Autor desconocido';
    if (src.type === 'journal') {
      return `${authorStr} (${year}). ${title}. <em>${journal}</em>.${doi}`;
    }
    return `${authorStr} (${year}). <em>${title}</em>.${doi}`;
  }

  // Chicago nota completa / bibliografía
  const authorStr = authors.length > 0
    ? authors.map((a, i) => {
        const norm = normalizeAuthorName(a);
        if (i === 0) {
          return norm.firstName ? `${norm.lastName}, ${norm.firstName}` : norm.lastName;
        }
        return norm.firstName ? `${norm.firstName} ${norm.lastName}` : norm.lastName;
      }).join(', ')
    : 'Autor desconocido';

  if (src.type === 'journal') {
    return `${authorStr}. "${title}." <em>${journal}</em> (${year}).${doi}`;
  }
  return `${authorStr}. <em>${title}</em> (${year}).${doi}`;
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


