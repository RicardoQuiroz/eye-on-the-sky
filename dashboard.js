/**
 * Eye on the Sky — dashboard.js
 * Procesamiento en lote de archivos JSON del estudiante
 * Genera estadísticas del curso, alertas y vistas de detalle
 */

'use strict';

/* ================================================================
   ESTADO DEL DASHBOARD
   ================================================================ */

const Dash = {
  students:   [],       // Array de proyectos parseados
  sortCol:    'student_name',
  sortAsc:    true,
  charts:     {},
  detailStudent: null,
};

/* ================================================================
   INICIALIZACIÓN
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  initUploadZone();
  initEventListeners();
  restoreTheme();
});

function initUploadZone() {
  const zone  = document.getElementById('upload-zone');
  const input = document.getElementById('json-file-input');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    loadFiles(Array.from(e.dataTransfer.files));
  });

  input.addEventListener('change', () => loadFiles(Array.from(input.files)));
}

function initEventListeners() {
  document.getElementById('dash-btn-theme').addEventListener('click', toggleTheme);
  document.getElementById('btn-export-report').addEventListener('click', exportCSV);
  document.getElementById('dash-search').addEventListener('input', renderTable);
  document.getElementById('dash-filter-alert').addEventListener('change', renderTable);
  document.getElementById('close-student-detail').addEventListener('click', () => {
    document.getElementById('student-detail').classList.add('hidden');
    Dash.detailStudent = null;
  });

  // Modal de Apps Script y correo masivo
  const btnOpenEmailModal = document.getElementById('btn-open-email-modal');
  if (btnOpenEmailModal) {
    btnOpenEmailModal.addEventListener('click', openAppsScriptModal);
  }
  const btnCloseEmailModal = document.getElementById('close-modal-email');
  if (btnCloseEmailModal) {
    btnCloseEmailModal.addEventListener('click', closeAppsScriptModal);
  }
  const modalEmailOverlay = document.getElementById('modal-email-apps-script');
  if (modalEmailOverlay) {
    modalEmailOverlay.addEventListener('click', (e) => {
      if (e.target === modalEmailOverlay) closeAppsScriptModal();
    });
  }
  const btnCopyScript = document.getElementById('btn-copy-apps-script');
  if (btnCopyScript) {
    btnCopyScript.addEventListener('click', copyAppsScriptCode);
  }

  // Envío individual de correo desde el detalle del estudiante
  const btnDetailSendEmail = document.getElementById('detail-send-email-btn');
  if (btnDetailSendEmail) {
    btnDetailSendEmail.addEventListener('click', sendIndividualStudentEmail);
  }

  const btnSources = document.getElementById('detail-view-sources');
  if (btnSources) {
    btnSources.addEventListener('click', () => {
      const el = document.getElementById('section-detail-sources');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  const btnSessions = document.getElementById('detail-view-sessions');
  if (btnSessions) {
    btnSessions.addEventListener('click', () => {
      const el = document.getElementById('section-detail-sessions');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // Ordenamiento por columna
  document.querySelectorAll('#students-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (Dash.sortCol === col) Dash.sortAsc = !Dash.sortAsc;
      else { Dash.sortCol = col; Dash.sortAsc = true; }
      renderTable();
    });
  });
}

/* ================================================================
   CARGA Y PARSEO DE ARCHIVOS JSON
   ================================================================ */

async function loadFiles(files) {
  const jsonFiles = files.filter(f => f.name.endsWith('.json'));
  if (jsonFiles.length === 0) {
    showToast('Ningún archivo .json fue seleccionado.', 'warning');
    return;
  }

  showToast(`Cargando ${jsonFiles.length} archivo(s)…`, 'success');

  const results = await Promise.allSettled(jsonFiles.map(parseStudentFile));
  let loaded = 0;
  let errors = 0;

  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      // Evitar duplicados por nombre del proyecto
      const existingIdx = Dash.students.findIndex(s => s._filename === r.value._filename);
      if (existingIdx >= 0) Dash.students[existingIdx] = r.value;
      else Dash.students.push(r.value);
      loaded++;
    } else {
      errors++;
      console.warn(`Error en ${jsonFiles[i].name}:`, r.reason);
    }
  });

  showToast(`${loaded} proyecto(s) cargado(s).${errors > 0 ? ` ${errors} con error.` : ''}`, loaded > 0 ? 'success' : 'error');

  if (Dash.students.length > 0) {
    document.getElementById('dash-main').classList.remove('hidden');
    renderCourseStats();
    renderCharts();
    renderTable();

    // Actualizar label del curso
    const courses = [...new Set(Dash.students.map(s => s.metadata?.course).filter(Boolean))];
    document.getElementById('dash-course-label').textContent = courses.join(', ');
  }
}

async function parseStudentFile(file) {
  let text = '';
  try {
    text = await file.text();
  } catch (readErr) {
    throw new Error(`No se pudo leer el archivo "${file.name}": ${readErr.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (parseErr) {
    throw new Error(`El archivo "${file.name}" contiene JSON inválido o corrupto.`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`El archivo "${file.name}" no tiene una estructura de proyecto válida.`);
  }

  // Verificar firma de integridad
  const storedSig = parsed._signature;
  parsed._integrity_ok = false;
  if (storedSig) {
    try {
      const valid = await verifySignature(parsed);
      parsed._integrity_ok = valid;
    } catch (sigErr) {
      console.warn(`Error al verificar firma en "${file.name}":`, sigErr);
      parsed._integrity_ok = false;
    }
  }

  parsed._filename = file.name;
  parsed._filesize = file.size;
  parsed._loaded_at = new Date().toISOString();

  // Calcular métricas derivadas
  parsed._metrics = computeMetrics(parsed);
  parsed._alerts  = computeAlerts(parsed._metrics);

  return parsed;
}

function computeMetrics(project) {
  const tele     = project.telemetry?.summary || {};
  const sources  = project.sources || [];
  const sessions = project.telemetry?.sessions || [];
  const content  = project.content || {};

  const wordCount = countWords(
    content.html ? stripHTML(content.html) : (content.text || '')
  );

  const totalSessions = tele.total_sessions || sessions.length || 0;
  const daysActive = tele.total_days_active || new Set(sessions.map(s => s.date).filter(Boolean)).size || 0;

  // Caracteres pegados y palabras iniciales exentas calculadas con rigor
  let charsPastedClean = 0;
  let penalizedPasteWordsClean = 0;
  let initialPasteWords = 0;
  let hasSessionPastes = false;

  sessions.forEach(s => {
    (s.paste_events || []).forEach(p => {
      hasSessionPastes = true;
      if (p.is_initial) {
        initialPasteWords += (p.approx_words || Math.round((p.chars_pasted || 0) / 5));
      } else {
        charsPastedClean += (p.chars_pasted || 0);
        penalizedPasteWordsClean += (p.approx_words || Math.round((p.chars_pasted || 0) / 5));
      }
    });
  });

  // Fallback si no hay paste_events detallados pero summary tiene total_chars_pasted
  if (!hasSessionPastes && tele.total_chars_pasted !== undefined) {
    charsPastedClean = tele.total_chars_pasted;
  }

  const wordsTypedClean = tele.total_words_typed || sessions.reduce((sum, s) => sum + (s.words_typed || 0), 0);
  const totalActivity = wordsTypedClean + penalizedPasteWordsClean;
  const manualRatioClean = totalActivity > 0
    ? (wordsTypedClean / totalActivity)
    : (tele.manual_ratio !== undefined ? tele.manual_ratio : 1);

  const bio = project.biometrics || {};
  const hasBioBaseline = !!(bio.baseline && (bio.baseline.sample_size || 0) >= 100);
  const bioScore = (bio.session_metrics && bio.session_metrics.similarity_score !== undefined)
    ? bio.session_metrics.similarity_score
    : (hasBioBaseline ? 100 : null);
  const bioDwell = bio.session_metrics?.mean_dwell_ms || bio.baseline?.mean_dwell_ms || null;
  const bioFlight = bio.session_metrics?.mean_flight_ms || bio.baseline?.mean_flight_ms || null;

  return {
    student_name:          project.metadata?.student_name || extractNameFromFilename(project._filename),
    doc_title:             project.metadata?.title || 'Sin título',
    created_at:            project.metadata?.created_at,
    last_saved:            project.metadata?.last_saved,
    total_sessions:        totalSessions,
    total_days_active:     daysActive,
    total_words_typed:     wordsTypedClean,
    total_chars_pasted:    charsPastedClean,
    manual_ratio:          manualRatioClean,
    initial_paste_words:   initialPasteWords,
    sources_count:         sources.length,
    sources_with_screenshot: tele.sources_with_screenshot || sources.filter(s => s.screenshot_filename).length,
    sources_cited_in_text: tele.sources_cited_in_text || sources.filter(s => s.cited_in_text).length,
    word_count:            wordCount,
    integrity_ok:          project._integrity_ok,
    sessions:              sessions,
    has_biometric_baseline: hasBioBaseline,
    biometric_score:        bioScore,
    biometric_dwell:        bioDwell,
    biometric_flight:       bioFlight,
    biometrics_raw:         bio,
  };
}

function computeAlerts(m) {
  const alerts = [];

  // Palabras manuales reales descontando el material base inicial exento
  const netManualManuscript = Math.max(0, m.word_count - (m.initial_paste_words || 0));

  // Alerta crítica: pocas sesiones para el volumen del trabajo
  if (m.total_sessions <= 1 && netManualManuscript > 200) {
    alerts.push({ level: 'danger', message: 'Documento realizado en 1 sola sesión (sin proceso incremental)' });
  } else if (m.total_sessions <= 2 && netManualManuscript > 600) {
    alerts.push({ level: 'warning', message: `Solo 2 sesiones para un manuscrito de ${netManualManuscript} palabras manuales` });
  }

  // Detección de salto anómalo entre sesiones
  if (m.sessions && m.sessions.length > 0) {
    m.sessions.forEach(s => {
      const net = (s.words_net_change !== undefined) ? s.words_net_change : ((s.final_word_count || 0) - (s.initial_word_count || 0));
      const min = Math.max(1, s.duration_minutes || 1);

      // Descontar palabras del pegado inicial si ocurrieron en esta sesión
      const sessionInitialWords = (s.paste_events || [])
        .filter(p => p.is_initial)
        .reduce((sum, p) => sum + (p.approx_words || Math.round((p.chars_pasted || 0) / 5)), 0);

      const netEffective = Math.max(0, net - sessionInitialWords);

      // Salto brusco: más de 400 palabras netas a un ritmo mayor de 65 palabras/minuto
      if (netEffective > 400 && (netEffective / min) > 65) {
        alerts.push({
          level: 'warning',
          message: `Salto atípico en sesión ${s.session_number || ''} (${s.date || ''}): +${netEffective} palabras en ${min} min`
        });
      }
    });
  }

  // Alerta crítica: poco texto manual
  if (m.manual_ratio < 0.40) {
    alerts.push({ level: 'danger', message: `Solo ${Math.round(m.manual_ratio * 100)}% texto escrito manualmente` });
  } else if (m.manual_ratio < 0.65) {
    alerts.push({ level: 'warning', message: `${Math.round(m.manual_ratio * 100)}% de escritura manual (bajo)` });
  }

  // Alerta de biometría de tecleo: discrepancia con huella del autor original
  if (m.has_biometric_baseline && m.biometric_score !== null && m.biometric_score < 60) {
    alerts.push({
      level: 'danger',
      message: `Anomalía biométrica crítica: ${m.biometric_score}% consistencia con la huella digital del autor (sospecha de suplantación o cambio de transcriptor)`
    });
  } else if (m.has_biometric_baseline && m.biometric_score !== null && m.biometric_score < 75) {
    alerts.push({
      level: 'warning',
      message: `Divergencia en dinámica de tecleo: ${m.biometric_score}% de consistencia con el patrón biomecánico registrado`
    });
  } else if (!m.has_biometric_baseline && m.word_count > 300) {
    alerts.push({
      level: 'warning',
      message: `Manuscrito de ${m.word_count} palabras sin huella biométrica de escritura calibrada`
    });
  }

  // Sin fuentes con captura
  if (m.sources_count > 0 && m.sources_with_screenshot === 0) {
    alerts.push({ level: 'danger', message: 'Ninguna fuente tiene captura de pantalla' });
  } else if (m.sources_count > 0 && m.sources_with_screenshot < m.sources_count / 2) {
    alerts.push({ level: 'warning', message: 'Menos de la mitad de fuentes tiene captura' });
  }

  // Sin fuentes registradas
  if (m.sources_count === 0) {
    alerts.push({ level: 'danger', message: 'No hay fuentes registradas' });
  }

  // Pocas días activos para el volumen de texto
  if (m.word_count > 1000 && m.total_days_active <= 1) {
    alerts.push({ level: 'warning', message: `${m.word_count} palabras en solo ${m.total_days_active} día(s)` });
  }

  // Integridad
  if (!m.integrity_ok) {
    alerts.push({ level: 'warning', message: 'Posible modificación manual del archivo JSON' });
  }

  return alerts;
}

function alertLevel(alerts) {
  if (alerts.some(a => a.level === 'danger'))  return 'danger';
  if (alerts.some(a => a.level === 'warning')) return 'warning';
  return 'ok';
}

/* ================================================================
   ESTADÍSTICAS DEL CURSO
   ================================================================ */

function renderCourseStats() {
  const metrics = Dash.students.map(s => s._metrics);
  const n = metrics.length;

  const avg = key => {
    const vals = metrics.map(m => m[key]).filter(v => typeof v === 'number');
    return vals.length ? (vals.reduce((a,b) => a+b,0) / vals.length) : 0;
  };

  const countAlerts = level => Dash.students.filter(s => alertLevel(s._alerts) === level).length;

  const stats = [
    { label: 'Estudiantes cargados',   value: n },
    { label: 'Sin alertas',            value: countAlerts('ok'),      color: 'var(--success)' },
    { label: 'Con alertas leves',      value: countAlerts('warning'), color: 'var(--warning)' },
    { label: 'Con alertas críticas',   value: countAlerts('danger'),  color: 'var(--danger)' },
    { label: 'Promedio % manual',      value: Math.round(avg('manual_ratio') * 100) + '%' },
    { label: 'Promedio sesiones',      value: avg('total_sessions').toFixed(1) },
    { label: 'Promedio fuentes',       value: avg('sources_count').toFixed(1) },
    { label: 'Promedio palabras',      value: Math.round(avg('word_count')) },
  ];

  const grid = document.getElementById('course-stats-grid');
  grid.innerHTML = stats.map(s => `
    <div class="stat-card">
      <div class="stat-card-value" style="${s.color ? `color: ${s.color}` : ''}">${s.value}</div>
      <div class="stat-card-label">${s.label}</div>
    </div>
  `).join('');
}

/* ================================================================
   GRÁFICOS (Chart.js)
   ================================================================ */

function renderCharts() {
  const metrics = Dash.students.map(s => s._metrics);
  const names   = metrics.map(m => shortName(m.student_name));

  // Destruir gráficos anteriores si existen
  Object.values(Dash.charts).forEach(c => c.destroy());
  Dash.charts = {};

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
  const textColor = isDark ? '#9ba3b8' : '#52596b';

  Chart.defaults.color  = textColor;
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size   = 11;

  // Gráfico 1: % manual vs paste
  const ctx1 = document.getElementById('chart-manual-vs-paste').getContext('2d');
  Dash.charts.manual = new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: names,
      datasets: [
        {
          label: '% Manual',
          data: metrics.map(m => Math.round(m.manual_ratio * 100)),
          backgroundColor: 'rgba(74,108,247,0.75)',
          borderRadius: 4,
        },
        {
          label: '% Pegado (aprox.)',
          data: metrics.map(m => Math.round((1 - m.manual_ratio) * 100)),
          backgroundColor: 'rgba(229,57,53,0.55)',
          borderRadius: 4,
        }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom' }, tooltip: { mode: 'index' } },
      scales: {
        x: { stacked: true, grid: { color: gridColor } },
        y: { stacked: true, max: 100, grid: { color: gridColor }, ticks: { callback: v => v + '%' } }
      }
    }
  });

  // Gráfico 2: Sesiones por estudiante
  const ctx2 = document.getElementById('chart-sessions').getContext('2d');
  Dash.charts.sessions = new Chart(ctx2, {
    type: 'bar',
    data: {
      labels: names,
      datasets: [{
        label: 'Sesiones',
        data: metrics.map(m => m.total_sessions),
        backgroundColor: 'rgba(16,185,129,0.75)',
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: gridColor } },
        y: { beginAtZero: true, grid: { color: gridColor } }
      }
    }
  });
}

/* ================================================================
   TABLA DE ESTUDIANTES
   ================================================================ */

function renderTable() {
  const search      = document.getElementById('dash-search').value.toLowerCase();
  const alertFilter = document.getElementById('dash-filter-alert').value;

  let data = Dash.students.filter(s => {
    const name = (s._metrics.student_name || '').toLowerCase();
    if (search && !name.includes(search)) return false;
    if (alertFilter && alertLevel(s._alerts) !== alertFilter) return false;
    return true;
  });

  // Ordenar
  data.sort((a, b) => {
    let va = a._metrics[Dash.sortCol];
    let vb = b._metrics[Dash.sortCol];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return Dash.sortAsc ? -1 : 1;
    if (va > vb) return Dash.sortAsc ? 1  : -1;
    return 0;
  });

  const tbody = document.getElementById('students-table-body');
  tbody.innerHTML = '';

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align: center; padding: 32px; color: var(--text-muted);">No se encontraron resultados.</td></tr>`;
    return;
  }

  data.forEach(student => {
    const m     = student._metrics;
    const level = alertLevel(student._alerts);
    const tr    = document.createElement('tr');

    tr.innerHTML = `
      <td>
        <div style="font-weight: 600;">${escapeHtml(m.student_name)}</div>
        <div class="text-sm text-muted" style="font-size: 0.73rem; margin-top: 1px;">${escapeHtml(m.doc_title)}</div>
      </td>
      <td><strong>${m.total_sessions}</strong></td>
      <td>${m.total_days_active}</td>
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 50px; height: 6px; background: var(--border); border-radius: 99px; overflow: hidden;">
            <div style="height: 100%; width: ${Math.round(m.manual_ratio * 100)}%; background: ${ratioColor(m.manual_ratio)}; border-radius: 99px;"></div>
          </div>
          <span>${Math.round(m.manual_ratio * 100)}%</span>
        </div>
      </td>
      <td>${m.total_chars_pasted > 0 ? m.total_chars_pasted.toLocaleString() + ' car.' : '—'}</td>
      <td>${m.sources_count}</td>
      <td>${m.sources_with_screenshot} / ${m.sources_count}</td>
      <td>${m.word_count.toLocaleString()}</td>
      <td>
        ${renderBiometricBadge(m)}
      </td>
      <td>
        ${level === 'ok'
          ? '<span class="alert-badge alert-ok">✓ Sin alertas</span>'
          : `<span class="alert-badge alert-${level}" title="${student._alerts.map(a => a.message).join('\n')}">
              ${level === 'danger' ? '⚠' : '!'} ${student._alerts.length} alerta(s)
             </span>`}
        ${!m.integrity_ok ? '<span class="alert-badge alert-warning" title="El JSON pudo haber sido modificado manualmente" style="margin-top: 3px; display: block;">⚠ JSON modificado</span>' : ''}
      </td>
      <td>
        <button class="btn btn-sm btn-ghost" onclick="showStudentDetail('${encodeURIComponent(student._filename)}')">
          Detalle
        </button>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

function renderBiometricBadge(m) {
  if (!m.has_biometric_baseline) {
    return `<span class="alert-badge" style="background:var(--border); color:var(--text-muted); font-size:0.75rem;" title="Aún no se ha completado la calibración (250 pulsaciones)">Sin huella</span>`;
  }
  const score = m.biometric_score ?? 100;
  const dwell = m.biometric_dwell ? `${m.biometric_dwell}ms` : '—';
  const flight = m.biometric_flight ? `${m.biometric_flight}ms` : '—';
  const title = `Permanencia: ${dwell} | Pausa: ${flight} | Consistencia: ${score}%`;

  if (score >= 75) {
    return `<span class="alert-badge alert-ok" style="font-size:0.75rem;" title="${title}">✓ ${score}% (Autor)</span>`;
  } else if (score >= 60) {
    return `<span class="alert-badge alert-warning" style="font-size:0.75rem;" title="${title}">! ${score}% (Divergente)</span>`;
  } else {
    return `<span class="alert-badge alert-danger" style="font-size:0.75rem;" title="${title}">⚠ ${score}% (Cambio autor)</span>`;
  }
}

/* ================================================================
   DETALLE DE ESTUDIANTE
   ================================================================ */

function showStudentDetail(encodedFilename) {
  const filename = decodeURIComponent(encodedFilename);
  const student  = Dash.students.find(s => s._filename === filename);
  if (!student) return;

  Dash.detailStudent = student;
  const m = student._metrics;

  document.getElementById('detail-student-name').textContent = m.student_name;
  document.getElementById('detail-doc-title').textContent    = m.doc_title;

  // Stats del detalle
  const detailStats = [
    { label: 'Palabras totales',    value: m.word_count.toLocaleString() },
    { label: 'Días de trabajo',     value: m.total_days_active },
    { label: 'Sesiones',            value: m.total_sessions },
    { label: 'Texto manual',        value: Math.round(m.manual_ratio * 100) + '%', color: ratioColor(m.manual_ratio) },
    {
      label: 'Huella biométrica',
      value: m.has_biometric_baseline ? `${m.biometric_score ?? 100}% coincidencia` : 'Sin huella',
      color: m.has_biometric_baseline
        ? ((m.biometric_score ?? 100) >= 75 ? 'var(--success)' : ((m.biometric_score ?? 100) >= 60 ? 'var(--warning)' : 'var(--danger)'))
        : 'var(--text-muted)'
    },
    { label: 'Fuentes registradas', value: m.sources_count },
    { label: 'Fuentes con captura', value: `${m.sources_with_screenshot}/${m.sources_count}` },
  ];

  document.getElementById('detail-stats-grid').innerHTML = detailStats.map(s => `
    <div class="stat-card">
      <div class="stat-card-value" style="${s.color ? `color: ${s.color}` : ''}">${s.value}</div>
      <div class="stat-card-label">${s.label}</div>
    </div>
  `).join('');

  // Alertas
  const alertsHTML = student._alerts.length > 0
    ? `<div style="margin-bottom: 16px;">
        <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 8px;">Alertas detectadas</div>
        ${student._alerts.map(a => `
          <div style="display: flex; gap: 8px; align-items: flex-start; margin-bottom: 6px; padding: 10px 12px; border-radius: 7px; background: var(--${a.level === 'danger' ? 'danger' : 'warning'}-light);">
            <span style="font-size: 0.9rem;">${a.level === 'danger' ? '⚠' : '!'}</span>
            <span class="text-sm" style="color: var(--${a.level === 'danger' ? 'danger' : 'warning'}); font-weight: 500;">${escapeHtml(a.message)}</span>
          </div>
        `).join('')}
      </div>`
    : `<div style="padding: 12px; background: var(--success-light); border-radius: 7px; color: var(--success); font-size: 0.85rem; margin-bottom: 16px; font-weight: 500;">✓ Sin alertas. El estudiante presenta indicadores de trabajo genuino.</div>`;

  // Huella biométrica del autor
  const bio = student.biometrics || {};
  let biometricsCardHTML = '';
  if (bio.baseline) {
    const b = bio.baseline;
    const currentScore = m.biometric_score ?? 100;
    const scoreColor = currentScore >= 75 ? 'var(--success)' : (currentScore >= 60 ? 'var(--warning)' : 'var(--danger)');
    biometricsCardHTML = `
      <div style="margin-bottom: 16px; padding: 14px 16px; background: var(--bg-sidebar); border-radius: 8px; border: 1px solid var(--border);">
        <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between;">
          <span>🎯 Huella digital de escritura (Dinámica de tecleo del autor)</span>
          <span style="color: var(--success); font-weight: 700;">✓ Calibrada (${b.sample_size || 250} pulsaciones)</span>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; font-size: 0.82rem;">
          <div>⏱️ <strong>Permanencia media:</strong><br><span style="font-weight:700; color:var(--primary); font-size:0.95rem;">${b.mean_dwell_ms} ms</span> <span style="font-size:0.73rem; color:var(--text-muted);">(±${b.std_dwell_ms} ms)</span></div>
          <div>⏸️ <strong>Pausa de vuelo:</strong><br><span style="font-weight:700; color:var(--primary); font-size:0.95rem;">${b.mean_flight_ms} ms</span> <span style="font-size:0.73rem; color:var(--text-muted);">(±${b.std_flight_ms} ms)</span></div>
          <div>␣ <strong>Espaciadora:</strong><br><span style="font-weight:600;">${b.space_dwell_ms || '—'} ms</span></div>
          <div>⌫ <strong>Corrección (Backspace):</strong><br><span style="font-weight:600;">${b.backspace_dwell_ms || '—'} ms</span></div>
          <div>🔒 <strong>Consistencia actual:</strong><br><span style="font-weight:700; color:${scoreColor}; font-size:0.95rem;">${currentScore}%</span></div>
        </div>
      </div>
    `;
  }

  // Fuentes
  const sourcesHTML = (student.sources || []).length > 0
    ? `<div id="section-detail-sources" style="margin-top: 16px;">
        <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 10px;">Fuentes registradas (${student.sources.length})</div>
        ${student.sources.map(src => `
          <div style="padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; background: var(--bg-sidebar);">
            <div style="font-size: 0.83rem; font-weight: 600;">${escapeHtml(src.title || 'Sin título')}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 3px; display: flex; gap: 10px; flex-wrap: wrap;">
              <span>${(src.authors || []).join('; ')}</span>
              <span>${src.year || '—'}</span>
              ${src.doi ? `<span>DOI: ${escapeHtml(src.doi)}</span>` : ''}
              <span style="color: ${src.screenshot_filename ? 'var(--success)' : 'var(--danger)'}">
                ${src.screenshot_filename ? '📸 Con captura' : '✗ Sin captura'}
              </span>
              <span style="color: ${src.cited_in_text ? 'var(--success)' : 'var(--text-muted)'}">
                ${src.cited_in_text ? '✓ Citado en texto' : 'Sin citar'}
              </span>
            </div>
          </div>
        `).join('')}
      </div>`
    : `<div class="text-sm text-muted" style="margin-top: 12px;">El estudiante no registró fuentes bibliográficas.</div>`;

  // Sesiones
  const sessions = student.telemetry?.sessions || [];

  // Línea de tiempo de progreso incremental si hay múltiples sesiones
  let progressTimelineHTML = '';
  if (sessions.length > 1) {
    const steps = sessions.map((s, idx) => {
      const net = (s.words_net_change !== undefined) ? s.words_net_change : ((s.final_word_count || 0) - (s.initial_word_count || 0));
      const sign = net > 0 ? '+' : '';
      return `<div style="display:inline-flex; align-items:center; gap:6px; background:var(--bg-main); border:1px solid var(--border); padding:5px 12px; border-radius:18px; font-size:0.75rem; white-space:nowrap;">
        <span style="font-weight:700; color:var(--primary);">S${s.session_number || (idx + 1)}</span>
        <span style="color:var(--text-muted);">${s.date ? s.date.slice(5) : ''}:</span>
        <strong>${s.final_word_count || 0} pal.</strong>
        <span style="color:${net >= 0 ? 'var(--success)' : 'var(--danger)'}; font-weight:600;">(${sign}${net})</span>
      </div>`;
    }).join('<span style="color:var(--text-muted); font-size:0.85rem; padding: 0 4px;">➔</span>');

    progressTimelineHTML = `
      <div style="margin-bottom: 14px; padding: 12px 14px; background: var(--bg-sidebar); border-radius: 8px; border: 1px solid var(--border);">
        <div style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 8px;">
          Evolución incremental del manuscrito (sesión a sesión)
        </div>
        <div style="display: flex; gap: 6px; align-items: center; overflow-x: auto; padding-bottom: 4px;">
          ${steps}
        </div>
      </div>
    `;
  }

  const sessionsHTML = sessions.length > 0
    ? `<div id="section-detail-sessions" style="margin-top: 20px;">
        <div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 10px;">
          Historial de sesiones (${sessions.length} registradas)
        </div>
        ${progressTimelineHTML}
        <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 8px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
            <thead>
              <tr style="background: var(--bg-sidebar); border-bottom: 1px solid var(--border);">
                <th style="text-align: center; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">#</th>
                <th style="text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">Fecha</th>
                <th style="text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">Horario</th>
                <th style="text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">Duración</th>
                <th style="text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">Progreso palabras</th>
                <th style="text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">Escrito manual</th>
                <th style="text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">Pegados</th>
                <th style="text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">Biometría sesión</th>
                <th style="text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;">Pulsaciones</th>
              </tr>
            </thead>
            <tbody>
              ${sessions.map((s, idx) => {
                const sDate = s.date ? new Date(s.date + 'T12:00:00').toLocaleDateString('es') : (s.start_time ? new Date(s.start_time).toLocaleDateString('es') : '—');
                const startTime = s.start_time ? new Date(s.start_time).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
                const endTime = s.end_time ? new Date(s.end_time).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
                const timeRange = startTime && endTime ? `${startTime} – ${endTime}` : (startTime || '—');
                const net = (s.words_net_change !== undefined) ? s.words_net_change : ((s.final_word_count || 0) - (s.initial_word_count || 0));
                const sign = net > 0 ? '+' : '';
                const nonInitialPastes = (s.paste_events || []).filter(p => !p.is_initial);
                const pasteCount = nonInitialPastes.length;
                const charsPasted = nonInitialPastes.reduce((sum, p) => sum + (p.chars_pasted || 0), 0);
                const hasInitialPaste = (s.paste_events || []).some(p => p.is_initial);

                const sBio = s.biometrics;
                let bioCell = '<span style="color:var(--text-muted);">—</span>';
                if (sBio && sBio.similarity_score !== null && sBio.similarity_score !== undefined) {
                  const isOk = sBio.similarity_score >= 75;
                  const isWarn = sBio.similarity_score >= 60;
                  const color = isOk ? 'var(--success)' : (isWarn ? 'var(--warning)' : 'var(--danger)');
                  bioCell = `<span style="color:${color}; font-weight:600;" title="Permanencia: ${sBio.mean_dwell_ms || '—'}ms, Muestras: ${sBio.samples || 0}">
                    ${sBio.similarity_score}% ${isOk ? '✓' : (isWarn ? '!' : '⚠')}
                  </span>`;
                }

                return `
                  <tr style="border-bottom: 1px solid var(--border);">
                    <td style="padding: 8px 10px; text-align: center; font-weight: 600; color: var(--primary);">
                      ${s.session_number || (idx + 1)}
                    </td>
                    <td style="padding: 8px 10px; font-weight: 500;">${sDate}</td>
                    <td style="padding: 8px 10px; color: var(--text-muted);">${timeRange}</td>
                    <td style="padding: 8px 10px;">${s.duration_minutes ? s.duration_minutes + ' min' : '—'}</td>
                    <td style="padding: 8px 10px;">
                      <span>${s.initial_word_count || 0} ➔ <strong>${s.final_word_count || 0}</strong></span>
                      <span style="font-size: 0.75rem; margin-left: 4px; color: ${net >= 0 ? 'var(--success)' : 'var(--danger)'}; font-weight: 600;">
                        (${sign}${net})
                      </span>
                    </td>
                    <td style="padding: 8px 10px;">${s.words_typed || 0} pal.</td>
                    <td style="padding: 8px 10px;">
                      ${pasteCount > 0
                        ? `<span style="color: var(--warning); font-weight: 600;">${pasteCount} (${charsPasted.toLocaleString()} car.)</span>`
                        : '<span style="color: var(--text-muted);">0</span>'
                      }
                      ${hasInitialPaste ? `<span class="badge" style="background: rgba(74, 108, 247, 0.15); color: var(--primary); font-size: 0.68rem; margin-left: 4px; padding: 2px 6px; border-radius: 4px; font-weight: 600;" title="Pegado de material base inicial exento de penalización">Base exenta</span>` : ''}
                    </td>
                    <td style="padding: 8px 10px;">${bioCell}</td>
                    <td style="padding: 8px 10px; color: var(--text-muted);">${(s.keystroke_count || 0).toLocaleString()}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`
    : `<div class="text-sm text-muted" style="margin-top: 16px; padding: 12px; border: 1px dashed var(--border); border-radius: 8px;">
        No hay registros individuales de sesiones en este archivo.
       </div>`;

  document.getElementById('detail-tabs-content').innerHTML = alertsHTML + biometricsCardHTML + sourcesHTML + sessionsHTML;

  // Mostrar panel
  document.getElementById('student-detail').classList.remove('hidden');
  document.getElementById('student-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ================================================================
   EXPORTAR REPORTE CSV
   ================================================================ */

function exportCSV() {
  if (Dash.students.length === 0) {
    showToast('No hay datos cargados para exportar.', 'warning');
    return;
  }

  const headers = [
    'Estudiante', 'Título del documento', 'Sesiones', 'Días activos',
    '% Manual', 'Caracteres pegados', 'Fuentes totales', 'Fuentes con captura',
    'Fuentes citadas en texto', 'Total palabras', 'Huella biométrica',
    'Similitud biométrica (%)', 'Permanencia media (ms)', 'Pausa de vuelo (ms)',
    'Nivel de alerta', 'Alertas', 'Integridad JSON'
  ];

  const rows = Dash.students.map(s => {
    const m = s._metrics;
    return [
      m.student_name,
      m.doc_title,
      m.total_sessions,
      m.total_days_active,
      Math.round(m.manual_ratio * 100) + '%',
      m.total_chars_pasted,
      m.sources_count,
      m.sources_with_screenshot,
      m.sources_cited_in_text,
      m.word_count,
      m.has_biometric_baseline ? 'CALIBRADA' : 'SIN HUELLA',
      m.biometric_score !== null ? m.biometric_score + '%' : 'N/A',
      m.biometric_dwell || 'N/A',
      m.biometric_flight || 'N/A',
      alertLevel(s._alerts),
      s._alerts.map(a => a.message).join(' | '),
      m.integrity_ok ? 'OK' : 'MODIFICADO',
    ].map(v => `"${String(v).replace(/"/g,'""')}"`);
  });

  const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM para Excel
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `reporte_curso_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast('Reporte CSV exportado.', 'success');
}

/* ================================================================
   FIRMA DE INTEGRIDAD (igual que en editor.js)
   ================================================================ */

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

async function verifySignature(payload) {
  const stored = payload._signature;
  if (!stored) return false;
  const clone = safeClone(payload);
  delete clone._signature;
  const secret = 'EyeOnTheSky-v1-integrity';
  const data   = secret + JSON.stringify(clone);
  const msgBuf = new TextEncoder().encode(data);
  const hashBuf = await crypto.subtle.digest('SHA-256', msgBuf);
  const expected = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
  return stored === expected;
}

/* ================================================================
   UTILIDADES
   ================================================================ */

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(w => w.length > 0).length;
}

function stripHTML(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

function shortName(name) {
  if (!name) return '—';
  const parts = name.split(' ');
  return parts.length >= 2 ? `${parts[0]} ${parts[parts.length-1]}` : name;
}

function extractNameFromFilename(filename) {
  return (filename || 'Estudiante').replace('.json','').replace(/_/g,' ');
}

function ratioColor(ratio) {
  if (ratio >= 0.75) return 'var(--success)';
  if (ratio >= 0.50) return 'var(--warning)';
  return 'var(--danger)';
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

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
  localStorage.setItem('eots-theme', theme);
  document.getElementById('dash-theme-icon-light').classList.toggle('hidden', theme === 'dark');
  document.getElementById('dash-theme-icon-dark').classList.toggle('hidden', theme === 'light');
  // Regenerar gráficos con nuevo tema si hay datos
  if (Dash.students.length > 0) renderCharts();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(current === 'light' ? 'dark' : 'light');
}

/* ================================================================
   INTEGRACIÓN GOOGLE APPS SCRIPT Y CORREO MASIVO
   ================================================================ */

let cachedAppsScriptCode = '';

async function loadAppsScriptCodeText() {
  if (cachedAppsScriptCode) return cachedAppsScriptCode;
  try {
    const res = await fetch('codigo_apps_script.gs');
    if (res.ok) {
      cachedAppsScriptCode = await res.text();
      return cachedAppsScriptCode;
    }
  } catch (e) {
    // Si fetch falla por protocolo file://, cargamos fallback seguro
  }
  cachedAppsScriptCode = `// 🛰️ EYE ON THE SKY — Google Apps Script (Envío masivo desde Google Sheets)
// Consulta el archivo completo 'codigo_apps_script.gs' en la carpeta raíz del proyecto.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎓 Eye on the Sky')
    .addItem('📧 Enviar reportes gráficos a estudiantes', 'enviarReportesEstudiantes')
    .addItem('👁️ Vista previa del correo', 'previsualizarCorreoFila')
    .addToUi();
}
// Descarga el archivo 'codigo_apps_script.gs' desde el botón de la ventana modal para ver el código completo.`;
  return cachedAppsScriptCode;
}

async function openAppsScriptModal() {
  const modal = document.getElementById('modal-email-apps-script');
  if (!modal) return;
  modal.classList.remove('hidden');

  const codeEl = document.getElementById('code-snippet-apps-script');
  if (codeEl) {
    const code = await loadAppsScriptCodeText();
    codeEl.textContent = code;
  }
}

function closeAppsScriptModal() {
  const modal = document.getElementById('modal-email-apps-script');
  if (modal) modal.classList.add('hidden');
}

async function copyAppsScriptCode() {
  const code = await loadAppsScriptCodeText();
  let copied = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
    } catch (clipErr) {
      console.debug('navigator.clipboard falló, intentando método fallback:', clipErr);
    }
  }

  if (!copied) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = code;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.setAttribute('readonly', '');
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      copied = document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch (err) {
      console.warn('Fallback de copia falló:', err);
    }
  }

  if (copied) {
    showToast('✓ ¡Código de Apps Script copiado al portapapeles!', 'success');
  } else {
    showToast('Por favor selecciona el texto en el recuadro inferior para copiarlo manualmente o descarga el archivo .gs', 'info');
  }
}

function sendIndividualStudentEmail() {
  const student = Dash.detailStudent;
  if (!student) {
    showToast('Por favor selecciona un estudiante primero.', 'warning');
    return;
  }

  const m = student._metrics;
  const nombre = m.student_name || 'Estudiante';
  const doc = m.doc_title || 'Documento de investigación';
  const palabras = (m.word_count || 0).toLocaleString();
  const sesiones = m.total_sessions || 1;
  const dias = m.total_days_active || 1;
  const manualPct = Math.round((m.manual_ratio || 1) * 100) + '%';
  const huella = m.has_biometric_baseline ? `${m.biometric_score ?? 100}% de coincidencia con huella del autor` : 'Aún en calibración';
  const fuentesCaptura = `${m.sources_with_screenshot || 0} de ${m.sources_count || 0}`;

  const alertas = (student._alerts && student._alerts.length > 0)
    ? student._alerts.map(a => `• [${a.level.toUpperCase()}] ${a.message}`).join('\n')
    : '• Sin alertas. Proceso regular y consistente con redacción humana y citas verificadas.';

  const subject = `[Eye on the Sky] Retroalimentación de manuscrito — ${nombre}`;
  const body = `Estimado/a ${nombre},

Te comparto el estado actual del seguimiento de telemetría y redacción para tu trabajo académico:
"${doc}"

📊 RESUMEN DE PROGRESO:
• Palabras actuales: ${palabras}
• Sesiones de redacción registradas: ${sesiones} (en ${dias} día(s) activo(s))
• Tasa de escritura manual: ${manualPct}
• Huella biométrica de autoría: ${huella}
• Fuentes científicas con evidencia/captura: ${fuentesCaptura}

🔍 OBSERVACIONES DOCENTES Y ALERTAS:
${alertas}

Continúa con la redacción en la plataforma y recuerda registrar capturas y citas de todas las fuentes científicas consultadas.

Saludos cordiales,
Profesor del Seminario de Investigación`;

  const mailtoUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const link = document.createElement('a');
  link.href = mailtoUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast(`Abriendo cliente de correo para ${nombre}…`, 'info');
}
