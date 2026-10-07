/**
 * Eye on the Sky — cloud.js
 * Conexión con el "servidor" del curso: un Google Sheets + Apps Script del docente.
 *
 *  • Inicio de sesión con carnet + contraseña (enviada por el docente por correo).
 *  • Cada sesión de trabajo se envía como UNA FILA de la hoja "Sesiones" (como máximo
 *    cada SYNC_INTERVAL_S segundos y al salir de la página). Sin conexión, los envíos
 *    quedan en una cola local y se reintentan al volver la conexión.
 *  • El navegador pregunta periódicamente por el estado (Apps Script no puede "empujar"
 *    datos): así se actualizan sin recargar el panel "Actividad y Salud", el punto del
 *    estudiante y el punto rojo del docente.
 *  • No se envía el texto del trabajo ni las capturas: solo telemetría.
 */
(function () {
  'use strict';

  const CFG = window.EOTS_CONFIG || {};
  const URL_ = (CFG.WEB_APP_URL || '').trim();
  const LS = {
    auth: 'eots-cloud-auth',        // { carnet, token, nombre, correo }
    queue: 'eots-sync-queue',       // { session_id: { carnet, project, snapshot, session } }
    estado: 'eots-cloud-estado',    // último estado recibido (para mostrarlo sin conexión)
    seen: 'eots-seen-alerts-',      // + carnet: códigos de alerta ya vistos por el estudiante
    skip: 'eots-cloud-skip-until',
    teacherKey: 'eots-teacher-key',
  };
  const jget = (k, def) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (_) { return def; } };
  const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  const Cloud = {
    enabled: !!URL_,
    auth: jget(LS.auth, null),
    estado: jget(LS.estado, null),
    lastSync: null,
    lastError: null,
    flushing: false,
    lastFlushAt: 0,
    flushTimer: null,
    teacherAlerts: null,

    /* ---------------- Red ---------------- */
    /** Últimos caracteres del ID de la implementación (para comparar con la del docente). */
    serverTag() {
      const m = URL_.match(/\/s\/([^/]+)\/(exec|dev)/);
      return m ? '…' + m[1].slice(-6) + '/' + m[2] : URL_;
    },

    async post(body) {
      const payload = JSON.stringify(body);
      let firstError = null;
      try {
        // text/plain evita la "verificación previa" (CORS) que Apps Script no responde.
        // credentials:'omit' evita que las cuentas de Google abiertas en el navegador
        // desvíen la petición (causa habitual de 404 en tabletas y celulares).
        const res = await fetch(URL_, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: payload,
          redirect: 'follow',
          credentials: 'omit',
          cache: 'no-store',
        });
        if (res.ok) return await res.json();
        firstError = new Error('El servidor respondió ' + res.status);
      } catch (e) {
        firstError = e;
      }
      // Segundo intento por GET (?payload=) para peticiones pequeñas que no llevan
      // contraseña (estado, panel docente). La contraseña nunca viaja en la URL.
      if (payload.length < 6000 && body.action !== 'login') {
        try {
          const res = await fetch(URL_ + (URL_.includes('?') ? '&' : '?') + 'payload=' + encodeURIComponent(payload), {
            method: 'GET', redirect: 'follow', credentials: 'omit', cache: 'no-store',
          });
          if (res.ok) return await res.json();
          firstError = new Error('El servidor respondió ' + res.status);
        } catch (e) { /* conservar el primer error */ }
      }
      const msg = (firstError && firstError.message) || 'Error de red';
      throw new Error(msg + ' (servidor ' + this.serverTag() + ')');
    },

    /* ---------------- Sesión del estudiante ---------------- */
    isLoggedIn() { return !!(this.auth && this.auth.token); },

    async login(carnet, password) {
      const r = await this.post({ action: 'login', carnet, password });
      if (!r.ok) throw new Error(r.error || 'No se pudo iniciar sesión.');
      this.auth = { carnet: r.carnet, token: r.token, nombre: r.nombre, correo: r.correo };
      jset(LS.auth, this.auth);
      this.applyIdentity();
      this.flush(true);
      this.startPolling();
      await this.refreshEstado();
      return r;
    },

    logout() {
      this.auth = null;
      this.estado = null;
      try { localStorage.removeItem(LS.auth); localStorage.removeItem(LS.estado); } catch (_) {}
      this.render();
    },

    /** El nombre y correo oficiales vienen de la lista del docente. */
    applyIdentity() {
      if (!this.auth || typeof App === 'undefined' || !App.project) return;
      const md = App.project.metadata;
      if (md.student_id && md.student_id !== this.auth.carnet) {
        showToast(`⚠ Este documento estaba asociado al carnet ${md.student_id}. Las nuevas sesiones se registrarán con el carnet ${this.auth.carnet}.`, 'warning');
      }
      md.student_id = this.auth.carnet;
      md.student_name = this.auth.nombre || md.student_name;
      md.student_email = this.auth.correo || md.student_email;
      if (typeof syncAuthorInputs === 'function') syncAuthorInputs();
      App.ui.isDirty = true;
    },

    /* ---------------- Cola de envío ---------------- */
    /** Lo llama saveProject() en cada guardado con el registro de la sesión actual. */
    enqueue(sessionRecord, metrics) {
      if (!this.enabled || !sessionRecord || !sessionRecord.session_id) return;
      const q = jget(LS.queue, {});
      q[sessionRecord.session_id] = {
        carnet: this.auth ? this.auth.carnet : null,
        project: { id: App.project.metadata.project_id, title: App.project.metadata.title || '' },
        snapshot: EOTS.makeSnapshot({ ...metrics, _baseline: BiometricsEngine.baseline() }),
        session: EOTS.compactSession(sessionRecord),
      };
      jset(LS.queue, q);
      this.scheduleFlush();
      this.render();
    },

    pendingCount() { return Object.keys(jget(LS.queue, {})).length; },

    scheduleFlush() {
      const wait = Math.max(0, (CFG.SYNC_INTERVAL_S || 60) * 1000 - (Date.now() - this.lastFlushAt));
      if (this.flushTimer) return;
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, wait);
    },

    async flush(force) {
      if (!this.enabled || !this.isLoggedIn() || this.flushing || !navigator.onLine) return;
      if (!force && Date.now() - this.lastFlushAt < (CFG.SYNC_INTERVAL_S || 60) * 1000) { this.scheduleFlush(); return; }
      this.flushing = true;
      this.lastFlushAt = Date.now();
      try {
        const q = jget(LS.queue, {});
        for (const [id, item] of Object.entries(q)) {
          if (item.carnet && item.carnet !== this.auth.carnet) continue; // sesiones de otra persona en este equipo
          const r = await this.post({
            action: 'sync', carnet: this.auth.carnet, token: this.auth.token,
            project: item.project, snapshot: item.snapshot, sessions: [item.session],
          });
          if (!r.ok) {
            if (r.auth === false) { this.handleAuthLost(r.error); return; }
            throw new Error(r.error || 'Error del servidor');
          }
          const now = jget(LS.queue, {});
          // Solo se elimina si no cambió mientras se enviaba
          if (now[id] && JSON.stringify(now[id].session) === JSON.stringify(item.session)) delete now[id];
          jset(LS.queue, now);
          if (r.estado) this.setEstado(r.estado);
        }
        this.lastSync = new Date();
        this.lastError = null;
      } catch (err) {
        this.lastError = err.message || String(err);
      } finally {
        this.flushing = false;
        this.render();
      }
    },

    /** Al salir de la página: envío "de último momento" de la sesión en curso. */
    beacon() {
      if (!this.enabled || !this.isLoggedIn() || !navigator.sendBeacon) return;
      const q = jget(LS.queue, {});
      const item = App.session && App.session.id ? q[App.session.id] : null;
      if (!item) return;
      const body = JSON.stringify({ action: 'sync', carnet: this.auth.carnet, token: this.auth.token,
        project: item.project, snapshot: item.snapshot, sessions: [item.session] });
      try { navigator.sendBeacon(URL_, new Blob([body], { type: 'text/plain;charset=utf-8' })); } catch (_) {}
    },

    handleAuthLost(msg) {
      this.auth = null;
      try { localStorage.removeItem(LS.auth); } catch (_) {}
      showToast(msg || 'Tu sesión venció. Vuelve a iniciar sesión para registrar tu trabajo.', 'warning');
      this.render();
      this.showLogin();
    },

    /**
     * Antes de crear un documento nuevo: si el estudiante ya tiene otro documento registrado,
     * recordarle que para continuarlo en este dispositivo debe abrir su paquete .zip.
     */
    confirmNewDocument() {
      const m = this.estado && this.estado.metrics;
      if (!this.isLoggedIn() || !m || !m.project_id) return true;
      return confirm(`Ya tienes registrado el documento «${m.doc_title}» (${m.total_sessions} sesión(es), ${m.word_count} palabras).\n\n` +
        `Si quieres CONTINUARLO en este dispositivo, pulsa Cancelar y abre su paquete .zip (Abrir proyecto).\n\n` +
        `¿Crear un documento NUEVO de todos modos?`);
    },

    /* ---------------- Estado y alertas ---------------- */
    setEstado(estado) {
      this.estado = estado;
      jset(LS.estado, estado);
      if (typeof updateTelemetryUI === 'function') { App.ui.forceTelemetry = true; updateTelemetryUI(); App.ui.forceTelemetry = false; }
      this.render();
    },

    async refreshEstado() {
      if (!this.enabled || !this.isLoggedIn() || !navigator.onLine) return;
      try {
        const r = await this.post({ action: 'estado', carnet: this.auth.carnet, token: this.auth.token });
        if (!r.ok && r.auth === false) { this.handleAuthLost(r.error); return; }
        if (r.ok && r.estado) this.setEstado(r.estado);
      } catch (_) { /* sin conexión: se reintenta en el próximo ciclo */ }
    },

    alertCodes(alerts) {
      return Array.from(new Set((alerts || []).filter(a => a.level === 'danger' || a.level === 'warning').map(a => a.code)));
    },

    unseenStudentAlerts() {
      if (!this.estado || !this.auth) return [];
      const seen = jget(LS.seen + this.auth.carnet, []);
      return this.alertCodes(this.estado.alerts).filter(c => !seen.includes(c));
    },

    markStudentAlertsSeen() {
      if (!this.estado || !this.auth) return;
      jset(LS.seen + this.auth.carnet, this.alertCodes(this.estado.alerts));
      this.render();
    },

    /* ---------------- Punto rojo del docente ---------------- */
    teacherKey() { try { return localStorage.getItem(LS.teacherKey) || ''; } catch (_) { return ''; } },

    async refreshTeacher() {
      const key = this.teacherKey();
      if (!this.enabled || !key || !navigator.onLine) return;
      try {
        const r = await this.post({ action: 'docente_resumen', teacher_key: key, solo_alertas: true });
        if (r.ok) this.teacherAlerts = r.nuevas_alertas || [];
        else if (r.auth === false) this.teacherAlerts = null;
      } catch (_) {}
      this.render();
    },

    /* ---------------- Ciclos periódicos ---------------- */
    startPolling() {
      if (this._polling) return;
      this._polling = true;
      const every = (s, fn) => setInterval(() => { if (document.visibilityState === 'visible') fn(); }, s * 1000);
      every(CFG.POLL_STUDENT_S || 180, () => { this.flush(); this.refreshEstado(); });
      every(CFG.POLL_TEACHER_S || 60, () => this.refreshTeacher());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { this.refreshEstado(); this.refreshTeacher(); }
        else { this.flush(true); }
      });
      window.addEventListener('online', () => { this.flush(true); this.refreshEstado(); });
      window.addEventListener('pagehide', () => this.beacon());
      this.refreshEstado();
      this.refreshTeacher();
    },

    /* ---------------- Interfaz ---------------- */
    showLogin() {
      if (!this.enabled) return;
      const err = document.getElementById('login-error');
      if (err) err.textContent = '';
      openModal('modal-login-overlay');
      setTimeout(() => document.getElementById('login-carnet')?.focus(), 100);
    },

    async submitLogin() {
      const carnet = (document.getElementById('login-carnet')?.value || '').trim();
      const pwd = document.getElementById('login-password')?.value || '';
      const err = document.getElementById('login-error');
      const btn = document.getElementById('login-submit');
      if (!carnet || !pwd) { if (err) err.textContent = 'Escribe tu carnet y tu contraseña.'; return; }
      if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }
      try {
        const r = await this.login(carnet, pwd);
        closeModal('modal-login-overlay');
        document.getElementById('login-password').value = '';
        showToast(`✓ Hola, ${r.nombre}. Tus sesiones de trabajo quedarán registradas para el curso.`, 'success');
      } catch (e) {
        if (err) err.textContent = navigator.onLine ? e.message : 'Sin conexión a internet. Puedes trabajar y se registrará al volver la conexión.';
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Iniciar sesión'; }
      }
    },

    render() {
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
      const section = document.getElementById('cloud-section');
      if (section) section.style.display = this.enabled ? '' : 'none';
      if (!this.enabled) return;

      const pend = this.pendingCount();
      let status;
      if (!this.isLoggedIn()) status = '⚠ Sin iniciar sesión: tu trabajo aún no se registra en el curso.';
      else if (!navigator.onLine) status = `Sin conexión · ${pend} sesión(es) en espera de envío.`;
      else if (this.lastError) status = `⚠ No se pudo enviar (${this.lastError}). Se reintentará.`;
      else if (this.lastSync) status = `✓ Registrado ${this.lastSync.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}${pend ? ` · ${pend} pendiente(s)` : ''}`;
      else status = pend ? `${pend} sesión(es) por enviar…` : 'Conectado.';
      set('cloud-status', status);
      set('cloud-user', this.isLoggedIn() ? `${this.auth.nombre} · ${this.auth.carnet}` : '');
      show('cloud-login-btn', !this.isLoggedIn());
      show('cloud-logout-btn', this.isLoggedIn());

      // Punto del estudiante (sus propias alertas nuevas)
      const unseen = this.unseenStudentAlerts();
      document.querySelectorAll('.student-dot').forEach(d => {
        d.classList.toggle('visible', unseen.length > 0);
        d.title = unseen.length ? 'Hay observaciones nuevas sobre tu trabajo' : '';
      });

      // Punto rojo del docente (alertas nuevas de cualquier estudiante)
      const ta = this.teacherAlerts || [];
      document.querySelectorAll('.teacher-dot').forEach(d => {
        d.classList.toggle('visible', ta.length > 0);
        d.title = ta.map(a => `${a.nombre}: ${a.mensajes.join('; ')}`).join('\n');
      });
    },

    init() {
      if (!this.enabled) { this.render(); return; }
      document.getElementById('login-submit')?.addEventListener('click', () => this.submitLogin());
      document.getElementById('login-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') this.submitLogin(); });
      document.getElementById('login-skip')?.addEventListener('click', () => {
        closeModal('modal-login-overlay');
        showToast('Trabajarás sin registro por ahora. Tus sesiones se enviarán cuando inicies sesión.', 'info');
      });
      document.getElementById('cloud-login-btn')?.addEventListener('click', () => this.showLogin());
      document.getElementById('cloud-logout-btn')?.addEventListener('click', () => {
        if (confirm('¿Cerrar sesión en este dispositivo? (Útil en computadoras compartidas)')) this.logout();
      });
      if (!this.isLoggedIn() && !this.teacherKey()) setTimeout(() => this.showLogin(), 600);
      this.startPolling();
      this.render();
      if (this.isLoggedIn()) this.flush(true);
    },
  };

  window.Cloud = Cloud;
  document.addEventListener('DOMContentLoaded', () => Cloud.init());
})();
