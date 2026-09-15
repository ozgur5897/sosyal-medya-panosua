const STATUSES = [
  { key: "bekliyor", label: "Onay bekliyor", dot: "amber" },
  { key: "devam_ediyor", label: "Devam ediyor", dot: "blue" },
  { key: "tamamlandi", label: "Tamamlandı", dot: "green" },
  { key: "paylasildi", label: "Paylaşım yapıldı", dot: "teal" },
  { key: "iptal", label: "İptal edildi", dot: "slate" },
];

const PLATFORMS = [
  { key: "instagram", label: "Instagram" },
  { key: "x", label: "X" },
  { key: "youtube", label: "YouTube" },
  { key: "tiktok", label: "TikTok" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "facebook", label: "Facebook" },
];

const BRANDS = [
  { key: "bex_coffee", label: "Bex Coffee" },
  { key: "estanbul_gaming", label: "Estanbul Gaming" },
  { key: "ortak", label: "Ortak" },
];

const SIZES = [
  { key: "kare", label: "Kare (1:1)" },
  { key: "story", label: "Story (9:16)" },
  { key: "yatay", label: "Yatay (16:9)" },
];

const state = {
  me: null, // {id, username, display_name, role, is_admin}
  cards: [],
  openCardId: null,
  createPlatforms: [],
  createSizes: [],
  createBrand: "ortak",
  createAttachmentFile: null,
  bannerTimer: null,
  pollTimer: null,
  assignableUsers: [],
  filters: { search: "", brand: "", platform: "", assignee: "" },
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
};

function platformLabel(key) {
  return PLATFORMS.find((p) => p.key === key)?.label || key;
}
function brandLabel(key) {
  return BRANDS.find((b) => b.key === key)?.label || "Ortak";
}
function sizeLabel(key) {
  return SIZES.find((s) => s.key === key)?.label || key;
}
function statusLabel(key) {
  return STATUSES.find((s) => s.key === key)?.label || key;
}
function canManage() {
  return state.me && state.me.role === "sosyal_medya";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function remainingText(card) {
  if (card.status === "paylasildi") return "";
  const due = new Date(card.due_date);
  if (isNaN(due)) return "";
  const diffMs = due - new Date();
  const diffH = Math.round(Math.abs(diffMs) / 36e5);
  if (diffMs < 0) return diffH < 24 ? `${diffH} saat gecikti` : `${Math.round(diffH / 24)} gün gecikti`;
  return diffH < 24 ? `${diffH} saat kaldı` : `${Math.round(diffH / 24)} gün kaldı`;
}

function flash(msg) {
  const el = document.getElementById("banner");
  el.textContent = msg;
  el.classList.remove("hidden");
  if (state.bannerTimer) clearTimeout(state.bannerTimer);
  state.bannerTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

// api()'nin fırlattığı hatalar bazen sadece iç kontrol için kullanılan
// "unauthorized" işareti olabilir (oturum sona erdiğinde) — bunu asla
// olduğu gibi kullanıcıya göstermeyiz, her zaman Türkçe bir karşılığı var.
function displayError(err) {
  if (err && err.message === "unauthorized") {
    return "Oturumun sona erdi, giriş ekranına yönlendiriliyorsun…";
  }
  return (err && err.message) || "Bir şeyler ters gitti, tekrar dener misin?";
}

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  // /api/login ve /api/setup kendi 401'ini "kullanıcı adı/şifre hatalı" gibi normal bir
  // doğrulama hatası olarak döner — bu, oturumun sona erdiği anlamına gelmez (zaten
  // henüz giriş yapılmamış oluyor), o yüzden bu iki uç nokta için "oturum sona erdi"
  // yönlendirmesini tetiklemiyoruz; asıl hata mesajı normal şekilde gösterilir.
  const isAuthEndpoint = path === "/api/login" || path === "/api/setup";
  if (res.status === 401 && !isAuthEndpoint) {
    showAuthScreen();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    let msg = "Bir şeyler ters gitti";
    try {
      const body = await res.json();
      msg = body.detail || msg;
    } catch {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : null;
}

function apiJson(path, method, body) {
  return api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// Aynı butona art arda / çift tıklamada iki kez network isteği atılmasını önler
// (yavaş bir bağlantıda kullanıcı iki kez tıklarsa, ya da tarayıcı bir click
// olayını ender de olsa iki kez teslim ederse diye).
function onClickGuarded(el, handler) {
  el.addEventListener("click", async (e) => {
    if (el.dataset.busy === "1") return;
    el.dataset.busy = "1";
    try {
      await handler(e);
    } finally {
      el.dataset.busy = "";
    }
  });
}

// ---------------- Modal yardımcıları ----------------

function openModalEl(id) { document.getElementById(id).classList.add("is-open"); }
function closeModal(id) { document.getElementById(id).classList.remove("is-open"); }

function initModalClose() {
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.classList.remove("is-open");
    });
  });
}

// ---------------- Auth akışı ----------------

function showAuthScreen() {
  document.getElementById("app").classList.add("hidden");
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("setupScreen").classList.add("hidden");
  api("/api/setup-status")
    .then((s) => {
      document.getElementById(s.needs_setup ? "setupScreen" : "loginScreen").classList.remove("hidden");
    })
    .catch(() => {
      document.getElementById("loginScreen").classList.remove("hidden");
    });
}

async function boot() {
  try {
    const status = await api("/api/setup-status");
    if (status.needs_setup) {
      document.getElementById("setupScreen").classList.remove("hidden");
      return;
    }
  } catch {}

  try {
    const me = await api("/api/me");
    state.me = me;
    showApp();
  } catch {
    document.getElementById("loginScreen").classList.remove("hidden");
  }
}

let authSubmitting = false;

function initAuthForms() {
  document.getElementById("setupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (authSubmitting) return;
    authSubmitting = true;
    const errEl = document.getElementById("setupError");
    errEl.textContent = "";
    try {
      const me = await apiJson("/api/setup", "POST", {
        display_name: document.getElementById("su_display_name").value.trim(),
        username: document.getElementById("su_username").value.trim(),
        password: document.getElementById("su_password").value,
      });
      state.me = me;
      document.getElementById("setupScreen").classList.add("hidden");
      showApp();
    } catch (err) {
      errEl.textContent = displayError(err);
    } finally {
      authSubmitting = false;
    }
  });

  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (authSubmitting) return;
    authSubmitting = true;
    const errEl = document.getElementById("loginError");
    errEl.textContent = "";
    try {
      const me = await apiJson("/api/login", "POST", {
        username: document.getElementById("li_username").value.trim(),
        password: document.getElementById("li_password").value,
      });
      state.me = me;
      document.getElementById("loginScreen").classList.add("hidden");
      showApp();
    } catch (err) {
      errEl.textContent = displayError(err);
    } finally {
      authSubmitting = false;
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST" });
    } catch {}
    state.me = null;
    if (state.pollTimer) clearInterval(state.pollTimer);
    document.getElementById("app").classList.add("hidden");
    showAuthScreen();
  });
}

function showApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("setupScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("whoami").innerHTML =
    `<strong>${escapeHtml(state.me.display_name)}</strong> · ${state.me.role === "sosyal_medya" ? "Sosyal Medya Ekibi" : "İstek Sahibi"}`;
  document.getElementById("openHistoryBtn").style.display = canManage() ? "" : "none";
  document.getElementById("openUsersBtn").style.display = state.me.is_admin ? "" : "none";
  document.getElementById("exportCsvBtn").style.display = canManage() ? "" : "none";
  document.getElementById("downloadBackupBtn").style.display = state.me.is_admin ? "" : "none";
  fetchCards();
  fetchAssignableUsers();
  // Pano, yeni yorum rozetleri gibi şeyleri sayfa hiç yenilenmeden görebilsinler diye
  // düzenli aralıklarla kendini tazeler. Çıkış/tekrar giriş ile birden fazla
  // zamanlayıcı birikmesin diye öncekini temizleyip yeniden kuruyoruz.
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    fetchCards();
    fetchAssignableUsers();
  }, 30000);
}

async function fetchAssignableUsers() {
  try {
    state.assignableUsers = await api("/api/assignable-users");
  } catch {
    return; // sessizce geç, kritik değil
  }
  const options = state.assignableUsers.map((u) => `<option value="${u.id}">${escapeHtml(u.display_name)}</option>`).join("");
  const createSel = document.getElementById("f_assigned_to");
  if (createSel) {
    const prev = createSel.value;
    createSel.innerHTML = `<option value="">Atanmamış</option>${options}`;
    createSel.value = prev;
  }
  const filterSel = document.getElementById("filterAssignee");
  if (filterSel) {
    const prev = filterSel.value;
    filterSel.innerHTML = `<option value="">Herkes</option>${options}`;
    filterSel.value = prev;
  }
}

// ---------------- Pano ----------------

async function fetchCards() {
  try {
    state.cards = await api("/api/cards");
    renderBoard();
  } catch (err) {
    if (err.message !== "unauthorized") flash(displayError(err));
  }
}

function sortCards(cards) {
  return [...cards].sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    return new Date(b.created_at) - new Date(a.created_at);
  });
}

function applyFilters(cards) {
  const f = state.filters;
  return cards.filter((c) => {
    if (f.search && !c.description.toLowerCase().includes(f.search)) return false;
    if (f.brand && c.brand !== f.brand) return false;
    if (f.platform && !(c.platforms || []).includes(f.platform)) return false;
    if (f.assignee && String(c.assigned_to || "") !== f.assignee) return false;
    return true;
  });
}

function renderBoard() {
  const board = document.getElementById("board");
  const filtered = applyFilters(state.cards);
  const grouped = Object.fromEntries(STATUSES.map((s) => [s.key, []]));
  for (const c of sortCards(filtered)) grouped[c.status]?.push(c);

  board.innerHTML = STATUSES.map(
    (s) => `
    <section class="column" data-status="${s.key}">
      <div class="column__head">
        <span class="dot dot--${s.dot}" style="background:var(--${s.dot})"></span>
        <h2>${s.label}</h2>
        <span class="count">${grouped[s.key].length}</span>
      </div>
      <div class="column__list">
        ${grouped[s.key].length === 0 ? `<div class="column__empty">Burada iş yok</div>` : grouped[s.key].map(cardTileHtml).join("")}
      </div>
    </section>
  `
  ).join("");

  board.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("click", () => openDetail(Number(el.dataset.id)));
  });
}

function isApproaching(card) {
  if (card.is_overdue || card.status === "paylasildi" || card.status === "iptal") return false;
  const due = new Date(card.due_date);
  if (isNaN(due)) return false;
  const diffH = (due - new Date()) / 36e5;
  return diffH >= 0 && diffH <= 24;
}

function cardTileHtml(card) {
  const overdueClass = card.is_overdue ? "is-overdue" : "";
  const topColor = card.is_overdue ? "var(--red)" : `var(--${STATUSES.find((s) => s.key === card.status)?.dot || "amber"})`;
  const remaining = remainingText(card);
  const platformsHtml = (card.platforms || []).map((k) => `<span title="${escapeHtml(platformLabel(k))}">${escapeHtml(platformLabel(k))}</span>`).join(", ");
  const approaching = isApproaching(card);

  return `
    <article class="card ${overdueClass}" data-id="${card.id}" style="border-top-color:${topColor}">
      ${card.urgent ? `<span class="card__urgent-badge">Acil</span>` : ""}
      <div class="card__body">
        <div class="card__top-row">
          <span class="card__brand-tag">${escapeHtml(brandLabel(card.brand))}</span>
          <span class="card__platform-icons">${platformsHtml}</span>
        </div>
        <p class="card__desc">${escapeHtml(card.description)}</p>
        <div class="card__meta">
          <span>Paylaşım: ${formatDateTime(card.due_date)}</span>
          <span>Açan: ${escapeHtml(card.created_by_name || "")}</span>
          ${card.assigned_to_name ? `<span>Atanan: ${escapeHtml(card.assigned_to_name)}</span>` : ""}
          ${card.sizes?.length ? `<span>Boyut: ${card.sizes.map(sizeLabel).join(", ")}</span>` : ""}
          ${remaining ? `<span>${remaining}</span>` : ""}
        </div>
        ${card.is_overdue ? `<span class="card__overdue-tag">Gecikti</span>` : ""}
        ${approaching ? `<span class="card__approaching-tag">Yaklaşıyor</span>` : ""}
        ${card.unread_comments > 0 ? `<span class="card__unread-badge">💬 ${card.unread_comments} yeni yorum</span>` : ""}
      </div>
    </article>
  `;
}

// ---------------- Yeni iş oluşturma ----------------

function renderCreateChips() {
  document.getElementById("f_platforms").innerHTML = PLATFORMS.map(
    (p) => `<button type="button" class="chip ${state.createPlatforms.includes(p.key) ? "is-active-platform" : ""}" data-platform="${p.key}">${escapeHtml(p.label)}</button>`
  ).join("");
  document.getElementById("f_brand").innerHTML = BRANDS.map(
    (b) => `<button type="button" class="chip ${state.createBrand === b.key ? "is-active-brand" : ""}" data-brand="${b.key}">${escapeHtml(b.label)}</button>`
  ).join("");
  document.getElementById("f_sizes").innerHTML = SIZES.map(
    (s) => `<button type="button" class="chip ${state.createSizes.includes(s.key) ? "is-active-platform" : ""}" data-size="${s.key}">${escapeHtml(s.label)}</button>`
  ).join("");

  document.querySelectorAll("#f_platforms .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.platform;
      state.createPlatforms = state.createPlatforms.includes(k)
        ? state.createPlatforms.filter((x) => x !== k)
        : [...state.createPlatforms, k];
      renderCreateChips();
    });
  });
  document.querySelectorAll("#f_brand .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.createBrand = btn.dataset.brand;
      renderCreateChips();
    });
  });
  document.querySelectorAll("#f_sizes .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.size;
      state.createSizes = state.createSizes.includes(k)
        ? state.createSizes.filter((x) => x !== k)
        : [...state.createSizes, k];
      renderCreateChips();
    });
  });
}

function resetCreateForm() {
  document.getElementById("f_description").value = "";
  document.getElementById("f_due_date").value = "";
  document.getElementById("f_urgent").checked = false;
  document.getElementById("f_link").value = "";
  document.getElementById("f_assigned_to").value = "";
  document.getElementById("f_attachment").value = "";
  document.getElementById("f_attachment_preview").innerHTML = "";
  document.getElementById("f_attachment_btn").textContent = "Görsel veya video seç";
  document.getElementById("createError").textContent = "";
  state.createPlatforms = [];
  state.createSizes = [];
  state.createBrand = "ortak";
  state.createAttachmentFile = null;
  renderCreateChips();
}

function initCreateModal() {
  document.getElementById("openCreateModal").addEventListener("click", () => {
    resetCreateForm();
    openModalEl("createModal");
  });

  document.getElementById("f_attachment_btn").addEventListener("click", () => {
    document.getElementById("f_attachment").click();
  });

  document.getElementById("f_attachment").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    state.createAttachmentFile = file;
    document.getElementById("f_attachment_btn").textContent = file.name;
    const url = URL.createObjectURL(file);
    const preview = document.getElementById("f_attachment_preview");
    preview.innerHTML = file.type.startsWith("video/")
      ? `<video src="${url}" controls style="width:100%;max-height:160px;border-radius:6px;margin-top:6px;background:#000"></video>`
      : `<img src="${url}" style="width:100%;max-height:140px;object-fit:cover;border-radius:6px;margin-top:6px" />`;
  });

  onClickGuarded(document.getElementById("createSubmitBtn"), async () => {
    const errEl = document.getElementById("createError");
    errEl.textContent = "";
    const description = document.getElementById("f_description").value.trim();
    const dueDate = document.getElementById("f_due_date").value;
    if (!description) { errEl.textContent = "Açıklama boş olamaz."; return; }
    if (!dueDate) { errEl.textContent = "Paylaşım tarihini seçmen gerekiyor."; return; }
    if (state.createPlatforms.length === 0) { errEl.textContent = "En az bir platform seçmen gerekiyor."; return; }

    const btn = document.getElementById("createSubmitBtn");
    btn.disabled = true;
    btn.textContent = "Oluşturuluyor…";
    try {
      const fd = new FormData();
      fd.append("description", description);
      fd.append("due_date", dueDate);
      fd.append("urgent", document.getElementById("f_urgent").checked ? "true" : "false");
      fd.append("platforms", JSON.stringify(state.createPlatforms));
      fd.append("brand", state.createBrand);
      fd.append("link", document.getElementById("f_link").value.trim());
      fd.append("assigned_to", document.getElementById("f_assigned_to").value);
      fd.append("sizes", JSON.stringify(state.createSizes));
      if (state.createAttachmentFile) fd.append("attachment", state.createAttachmentFile);

      await api("/api/cards", { method: "POST", body: fd });
      closeModal("createModal");
      flash("İş oluşturuldu.");
      fetchCards();
    } catch (err) {
      errEl.textContent = displayError(err);
    } finally {
      btn.disabled = false;
      btn.textContent = "İşi oluştur";
    }
  });
}

// ---------------- Kart detayı ----------------

async function openDetail(id) {
  state.openCardId = id;
  try {
    const card = await api(`/api/cards/${id}`);
    renderDetail(card);
    openModalEl("detailModal");
    // Bu kartı "görüldü" olarak işaretle, pano rozetini sessizce güncelle
    api(`/api/cards/${id}/mark-read`, { method: "POST" })
      .then(() => {
        const local = state.cards.find((c) => c.id === id);
        if (local) local.unread_comments = 0;
        renderBoard();
      })
      .catch(() => {});
  } catch (err) {
    if (err.message !== "unauthorized") flash(displayError(err));
  }
}

function statusBadgeClass(status) {
  return { bekliyor: "badge--amber", devam_ediyor: "badge--blue", tamamlandi: "badge--green", paylasildi: "badge--teal", iptal: "badge--slate" }[status] || "badge--neutral";
}

function renderDetail(card) {
  const remaining = remainingText(card);
  const mine = canManage();

  const platformsHtml = (card.platforms || [])
    .map((k) => `<span class="platform-tag">${escapeHtml(platformLabel(k))}</span>`)
    .join("");
  const sizesHtml = (card.sizes || [])
    .map((k) => `<span class="platform-tag">${escapeHtml(sizeLabel(k))}</span>`)
    .join("");

  const mediaHtml = card.media.length
    ? `<div class="media-grid">${card.media
        .map((m) =>
          m.media_type === "video"
            ? `<div><video src="${m.file_path}" controls></video><div class="media-caption">${escapeHtml(m.uploaded_by_name)} · <a href="${m.file_path}" download class="media-download">İndir</a></div></div>`
            : `<div><a href="${m.file_path}" target="_blank" rel="noopener noreferrer"><img src="${m.file_path}" alt="" /></a><div class="media-caption">${escapeHtml(m.uploaded_by_name)} · <a href="${m.file_path}" download class="media-download">İndir</a></div></div>`
        )
        .join("")}</div>`
    : `<p class="empty-note">Henüz yüklenen görsel/video yok.</p>`;

  const commentsHtml = card.comments.length
    ? card.comments
        .map(
          (c) => `
        <div class="comment">
          <div class="comment__head">
            <span class="comment__author">${escapeHtml(c.author_name)}</span>
            <span class="comment__time">${formatDateTime(c.created_at)}</span>
          </div>
          <p class="comment__text">${escapeHtml(c.text)}</p>
        </div>`
        )
        .join("")
    : `<p class="empty-note">Henüz yorum yok.</p>`;

  let actionsHtml = "";
  if (mine) {
    if (card.status === "bekliyor") {
      actionsHtml += `<button class="btn btn--primary" id="btnApprove">İşi onayla</button>`;
      actionsHtml += `<button class="btn btn--danger-outline" id="btnReject">İptal et</button>`;
    }
    if (card.status === "devam_ediyor") actionsHtml += `<button class="btn btn--success" id="btnComplete">Tamamlandı olarak işaretle</button>`;
    if (card.status === "tamamlandi") {
      actionsHtml += `<button class="btn btn--teal" id="btnPublish">Paylaşıldı olarak işaretle</button>`;
      actionsHtml += `<button class="btn btn--ghost" id="btnReopen">Tekrar aç</button>`;
    }
    if (card.status === "paylasildi" || card.status === "iptal") actionsHtml += `<button class="btn btn--ghost" id="btnReopen">Tekrar aç</button>`;
    actionsHtml += `<button class="btn btn--ghost" id="btnEdit">Düzenle</button>`;
    actionsHtml += `<button class="btn btn--danger-outline" id="btnDeleteAsk">Sil</button>`;
  }

  document.getElementById("detailBody").innerHTML = `
    <div class="detail-status-row">
      <span class="badge ${statusBadgeClass(card.status)}">${escapeHtml(statusLabel(card.status))}</span>
      <span class="badge badge--neutral">${escapeHtml(brandLabel(card.brand))}</span>
      ${card.urgent ? `<span class="badge badge--urgent">Acil</span>` : ""}
      ${card.is_overdue ? `<span class="badge badge--red">Gecikti</span>` : ""}
    </div>
    ${platformsHtml ? `<div class="platform-tag-row">${platformsHtml}</div>` : ""}
    ${sizesHtml ? `<div class="platform-tag-row">${sizesHtml}</div>` : ""}

    <div id="viewBlock">
      <p class="detail-desc">${escapeHtml(card.description)}</p>
      ${card.link ? `<p style="margin:-8px 0 14px"><a href="${escapeHtml(card.link)}" target="_blank" rel="noopener noreferrer" style="color:var(--blue);font-size:13.5px;word-break:break-all">${escapeHtml(card.link)}</a></p>` : ""}
      <div class="detail-meta">
        <div><strong>${escapeHtml(card.created_by_name || "")}</strong>Açan · ${formatDateTime(card.created_at)}</div>
        <div><strong>${formatDateTime(card.due_date)}</strong>Paylaşım tarihi${remaining ? " · " + remaining : ""}</div>
        ${card.assigned_to_name ? `<div><strong>${escapeHtml(card.assigned_to_name)}</strong>Atanan</div>` : ""}
        ${card.approved_by_name ? `<div><strong>${escapeHtml(card.approved_by_name)}</strong>Onaylayan · ${formatDateTime(card.approved_at)}</div>` : ""}
        ${card.completed_by_name ? `<div><strong>${escapeHtml(card.completed_by_name)}</strong>Tamamlayan · ${formatDateTime(card.completed_at)}</div>` : ""}
        ${card.published_by_name ? `<div><strong>${escapeHtml(card.published_by_name)}</strong>Paylaşan · ${formatDateTime(card.published_at)}</div>` : ""}
        ${card.rejected_by_name ? `<div><strong>${escapeHtml(card.rejected_by_name)}</strong>İptal eden · ${formatDateTime(card.rejected_at)}</div>` : ""}
      </div>
      <div id="actionsBlock">
        ${mine ? `<div class="detail-actions">${actionsHtml}</div>` : `<p class="permission-note">Onaylama, tamamlama, paylaşma, düzenleme ve silme sosyal medya ekibi rolüne ait.</p>`}
      </div>
    </div>
    <div id="editBlock" class="hidden"></div>

    <div class="detail-section">
      <h4>Görsel / video</h4>
      ${mediaHtml}
      ${mine ? `
        <input type="file" id="d_media_file" accept="image/*,video/*" style="display:none" />
        <button type="button" class="btn btn--dashed" id="btnUploadMedia">Görsel veya video yükle</button>
        <p style="font-size:11px;color:var(--paper-muted);margin-top:6px">Videolar tarayıcı önizlemesinde büyük olabilir, yüklemesi biraz sürebilir.</p>
      ` : ""}
    </div>

    <div class="detail-section">
      <h4>Yorumlar</h4>
      <div class="comment-list">${commentsHtml}</div>
      <form class="comment-form" id="commentForm">
        <input type="text" id="d_comment_text" placeholder="Yorum yaz..." required />
        <button class="btn btn--primary" type="submit">Gönder</button>
      </form>
    </div>
  `;

  bindDetailActions(card);
}

function bindDetailActions(card) {
  const id = card.id;

  document.getElementById("btnApprove")?.addEventListener("click", () => runCardAction(`/api/cards/${id}/approve`, "POST"));
  document.getElementById("btnReject")?.addEventListener("click", () => runCardAction(`/api/cards/${id}/reject`, "POST"));
  document.getElementById("btnComplete")?.addEventListener("click", () => runCardAction(`/api/cards/${id}/complete`, "POST"));
  document.getElementById("btnPublish")?.addEventListener("click", () => runCardAction(`/api/cards/${id}/publish`, "POST"));
  document.getElementById("btnReopen")?.addEventListener("click", () => runCardAction(`/api/cards/${id}/reopen`, "POST"));

  document.getElementById("btnEdit")?.addEventListener("click", () => showEditForm(card));

  document.getElementById("btnDeleteAsk")?.addEventListener("click", () => {
    document.getElementById("actionsBlock").innerHTML = `
      <div class="confirm-box">
        <p>Bu işi silmek istediğine emin misin? Bu işlem geri alınamaz.</p>
        <div class="row">
          <button class="btn" style="background:var(--red);color:#fff" id="btnDeleteConfirm">Evet, sil</button>
          <button class="btn btn--ghost" id="btnDeleteCancel">Vazgeç</button>
        </div>
      </div>
    `;
    onClickGuarded(document.getElementById("btnDeleteConfirm"), async () => {
      const b = document.getElementById("btnDeleteConfirm");
      b.disabled = true;
      b.textContent = "Siliniyor…";
      try {
        await api(`/api/cards/${id}`, { method: "DELETE" });
        closeModal("detailModal");
        flash("İş silindi.");
        fetchCards();
      } catch (err) {
        if (err.message !== "unauthorized") flash(displayError(err));
        openDetail(id);
      }
    });
    document.getElementById("btnDeleteCancel").addEventListener("click", () => openDetail(id));
  });

  const uploadBtn = document.getElementById("btnUploadMedia");
  if (uploadBtn) {
    uploadBtn.addEventListener("click", () => document.getElementById("d_media_file").click());
    document.getElementById("d_media_file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      uploadBtn.disabled = true;
      uploadBtn.textContent = "Yükleniyor…";
      try {
        const fd = new FormData();
        fd.append("file", file);
        await api(`/api/cards/${id}/media`, { method: "POST", body: fd });
        await openDetail(id);
      } catch (err) {
        if (err.message !== "unauthorized") flash(displayError(err));
        uploadBtn.disabled = false;
        uploadBtn.textContent = "Görsel veya video yükle";
      }
    });
  }

  document.getElementById("commentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("d_comment_text");
    const text = input.value.trim();
    if (!text) return;
    try {
      const fd = new FormData();
      fd.append("text", text);
      await api(`/api/cards/${id}/comments`, { method: "POST", body: fd });
      input.value = "";
      await openDetail(id);
    } catch (err) {
      if (err.message !== "unauthorized") flash(displayError(err));
    }
  });
}

async function runCardAction(path, method) {
  const id = state.openCardId;
  try {
    await api(path, { method });
    await openDetail(id);
    fetchCards();
  } catch (err) {
    if (err.message !== "unauthorized") flash(displayError(err));
  }
}

function showEditForm(card) {
  document.getElementById("viewBlock").classList.add("hidden");
  const editBlock = document.getElementById("editBlock");
  editBlock.classList.remove("hidden");

  let ePlatforms = [...(card.platforms || [])];
  let eBrand = card.brand || "ortak";
  let eSizes = [...(card.sizes || [])];

  editBlock.innerHTML = `
    <label class="field">
      <span>Ne yapılmasını istiyorsun?</span>
      <textarea id="e_description" rows="4">${escapeHtml(card.description)}</textarea>
    </label>
    <div class="field">
      <span>Platformlar</span>
      <div class="chip-row" id="e_platforms"></div>
    </div>
    <div class="field">
      <span>Görsel boyutları</span>
      <div class="chip-row" id="e_sizes"></div>
    </div>
    <div class="field">
      <span>Marka</span>
      <div class="chip-row" id="e_brand"></div>
    </div>
    <label class="field">
      <span>Bağlantı (opsiyonel)</span>
      <input type="text" id="e_link" placeholder="https://..." value="${escapeHtml(card.link || "")}" />
    </label>
    <label class="field">
      <span>Ata (opsiyonel)</span>
      <select id="e_assigned_to">
        <option value="">Atanmamış</option>
        ${state.assignableUsers.map((u) => `<option value="${u.id}" ${card.assigned_to === u.id ? "selected" : ""}>${escapeHtml(u.display_name)}</option>`).join("")}
      </select>
    </label>
    <div class="field-row">
      <label class="field">
        <span>Paylaşım tarihi</span>
        <input type="datetime-local" id="e_due_date" value="${escapeHtml(card.due_date)}" />
      </label>
      <label class="field field--checkbox">
        <input type="checkbox" id="e_urgent" ${card.urgent ? "checked" : ""} />
        <span>Acil</span>
      </label>
    </div>
    <p class="authError" id="editError"></p>
    <div class="detail-actions">
      <button class="btn btn--primary" type="button" id="btnSaveEdit">Kaydet</button>
      <button class="btn btn--ghost" type="button" id="btnCancelEdit">Vazgeç</button>
    </div>
  `;

  function renderEPlatforms() {
    const el = document.getElementById("e_platforms");
    el.innerHTML = PLATFORMS.map(
      (p) => `<button type="button" class="chip ${ePlatforms.includes(p.key) ? "is-active-platform" : ""}" data-platform="${p.key}">${escapeHtml(p.label)}</button>`
    ).join("");
    el.querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.dataset.platform;
        ePlatforms = ePlatforms.includes(k) ? ePlatforms.filter((x) => x !== k) : [...ePlatforms, k];
        renderEPlatforms();
      });
    });
  }

  function renderEBrand() {
    const el = document.getElementById("e_brand");
    el.innerHTML = BRANDS.map(
      (b) => `<button type="button" class="chip ${eBrand === b.key ? "is-active-brand" : ""}" data-brand="${b.key}">${escapeHtml(b.label)}</button>`
    ).join("");
    el.querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        eBrand = btn.dataset.brand;
        renderEBrand();
      });
    });
  }

  function renderESizes() {
    const el = document.getElementById("e_sizes");
    el.innerHTML = SIZES.map(
      (s) => `<button type="button" class="chip ${eSizes.includes(s.key) ? "is-active-platform" : ""}" data-size="${s.key}">${escapeHtml(s.label)}</button>`
    ).join("");
    el.querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.dataset.size;
        eSizes = eSizes.includes(k) ? eSizes.filter((x) => x !== k) : [...eSizes, k];
        renderESizes();
      });
    });
  }

  renderEPlatforms();
  renderEBrand();
  renderESizes();

  document.getElementById("btnCancelEdit").addEventListener("click", () => openDetail(card.id));

  onClickGuarded(document.getElementById("btnSaveEdit"), async () => {
    const errEl = document.getElementById("editError");
    errEl.textContent = "";
    const description = document.getElementById("e_description").value.trim();
    const dueDate = document.getElementById("e_due_date").value;
    if (!description) { errEl.textContent = "Açıklama boş olamaz."; return; }
    if (!dueDate) { errEl.textContent = "Paylaşım tarihini seçmen gerekiyor."; return; }
    if (ePlatforms.length === 0) { errEl.textContent = "En az bir platform seçmen gerekiyor."; return; }

    const btn = document.getElementById("btnSaveEdit");
    btn.disabled = true;
    btn.textContent = "Kaydediliyor…";
    try {
      await apiJson(`/api/cards/${card.id}`, "PATCH", {
        description,
        due_date: dueDate,
        urgent: document.getElementById("e_urgent").checked,
        platforms: ePlatforms,
        brand: eBrand,
        link: document.getElementById("e_link").value.trim(),
        assigned_to: document.getElementById("e_assigned_to").value ? Number(document.getElementById("e_assigned_to").value) : null,
        sizes: eSizes,
      });
      flash("İş güncellendi.");
      await openDetail(card.id);
      fetchCards();
    } catch (err) {
      errEl.textContent = displayError(err);
      btn.disabled = false;
      btn.textContent = "Kaydet";
    }
  });
}

// ---------------- Geçmiş ----------------

async function openHistory() {
  try {
    const log = await api("/api/activity-log");
    renderHistory(log);
    openModalEl("historyModal");
  } catch (err) {
    if (err.message !== "unauthorized") flash(displayError(err));
  }
}

function renderHistory(log) {
  const body = document.getElementById("historyBody");
  if (log.length === 0) {
    body.innerHTML = `<p class="empty-note">Henüz düzenleme veya silme işlemi yok.</p>`;
    return;
  }
  const actionLabel = { edited: "düzenledi", deleted: "sildi" };
  body.innerHTML = log
    .map((entry, i) => {
      const canExpand = entry.action === "deleted" || (entry.action === "edited" && entry.payload.changes?.length);
      const shortDesc = (entry.card_description || "").slice(0, 40) + ((entry.card_description || "").length > 40 ? "…" : "");
      let detailsHtml = "";
      if (entry.action === "edited") {
        detailsHtml = `<div class="log-entry__details hidden" id="log-details-${i}">${entry.payload.changes
          .map(
            (c) => `<div class="log-change-row"><strong>${escapeHtml(c.field)}:</strong> <span class="before">${escapeHtml(formatLogValue(c.field, c.before))}</span> → <span class="after">${escapeHtml(formatLogValue(c.field, c.after))}</span></div>`
          )
          .join("")}</div>`;
      } else if (entry.action === "deleted" && entry.payload.snapshot) {
        const s = entry.payload.snapshot;
        detailsHtml = `
          <div class="log-entry__details hidden" id="log-details-${i}">
            <div class="log-snapshot">
              <p style="margin:0;white-space:pre-wrap">${escapeHtml(s.description)}</p>
              ${s.link ? `<p style="margin:0;font-size:12.5px"><a href="${escapeHtml(s.link)}" target="_blank" rel="noopener noreferrer" style="color:var(--blue);word-break:break-all">${escapeHtml(s.link)}</a></p>` : ""}
              <div class="log-snapshot-grid">
                <div>Marka: <strong>${escapeHtml(brandLabel(s.brand))}</strong></div>
                <div>Platformlar: <strong>${(s.platforms || []).map(platformLabel).join(", ") || "—"}</strong></div>
                <div>Görsel boyutları: <strong>${(s.sizes || []).map(sizeLabel).join(", ") || "—"}</strong></div>
                <div>Paylaşım tarihi: <strong>${formatDateTime(s.due_date)}</strong></div>
                <div>Acil: <strong>${s.urgent ? "Evet" : "Hayır"}</strong></div>
                <div>Açan: <strong>${escapeHtml(s.created_by || "")}</strong></div>
                <div>Silindiğinde durum: <strong>${escapeHtml(statusLabel(s.status))}</strong></div>
              </div>
              ${s.media_summary?.length ? `
                <div>
                  <p style="font-size:11.5px;color:var(--paper-muted);margin:4px 0 6px;font-weight:700">Görsel / video</p>
                  <div class="media-grid">
                    ${s.media_summary.map((m) =>
                      m.media_type === "video"
                        ? `<div><video src="${escapeHtml(m.file_path)}" controls></video><div class="media-caption">${escapeHtml(m.uploaded_by || "")} · <a href="${escapeHtml(m.file_path)}" download class="media-download">İndir</a></div></div>`
                        : `<div><a href="${escapeHtml(m.file_path)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(m.file_path)}" alt="" /></a><div class="media-caption">${escapeHtml(m.uploaded_by || "")} · <a href="${escapeHtml(m.file_path)}" download class="media-download">İndir</a></div></div>`
                    ).join("")}
                  </div>
                </div>
              ` : ""}
              ${s.comments?.length ? `<div>
                <p style="font-size:11.5px;color:var(--paper-muted);margin:4px 0 6px;font-weight:700">Yorumlar</p>
                ${s.comments.map((c) => `<div style="font-size:12px;background:var(--paper-2);border-radius:6px;padding:6px 9px;margin-bottom:4px"><strong>${escapeHtml(c.author || "")}:</strong> ${escapeHtml(c.text)}</div>`).join("")}
              </div>` : ""}
            </div>
          </div>`;
      }
      return `
        <div class="log-entry">
          <div class="log-entry__head" data-idx="${i}" data-expandable="${canExpand ? "1" : "0"}">
            <span><strong>${escapeHtml(entry.actor_name || "")}</strong>, "${escapeHtml(shortDesc)}" işini ${actionLabel[entry.action] || entry.action}${canExpand ? ` <span class="log-entry__expand-hint" data-hint="${i}">içeriği göster</span>` : ""}</span>
            <span class="log-entry__time">${formatDateTime(entry.created_at)}</span>
          </div>
          ${detailsHtml}
        </div>
      `;
    })
    .join("");

  body.querySelectorAll(".log-entry__head[data-expandable='1']").forEach((head) => {
    head.style.cursor = "pointer";
    head.addEventListener("click", () => {
      const idx = head.dataset.idx;
      const details = document.getElementById(`log-details-${idx}`);
      const hint = body.querySelector(`[data-hint="${idx}"]`);
      const nowHidden = details.classList.toggle("hidden");
      if (hint) hint.textContent = nowHidden ? "içeriği göster" : "gizle";
    });
  });
}

function formatLogValue(field, value) {
  if (field === "platformlar") return Array.isArray(value) ? value.map(platformLabel).join(", ") || "—" : value;
  if (field === "görsel boyutları") return Array.isArray(value) ? value.map(sizeLabel).join(", ") || "—" : value;
  if (field === "marka") return brandLabel(value);
  if (field === "acil durumu") return value ? "Evet" : "Hayır";
  if (field === "paylaşım tarihi") return formatDateTime(value);
  return value ?? "—";
}

// ---------------- Takvim ----------------

function openCalendar() {
  renderCalendar();
  openModalEl("calendarModal");
}

function renderCalendar() {
  const body = document.getElementById("calendarBody");
  const year = state.calendarMonth.getFullYear();
  const month = state.calendarMonth.getMonth();
  const monthNames = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
  const dayLabels = ["Pt", "Sa", "Ça", "Pe", "Cu", "Ct", "Pz"];

  const firstOfMonth = new Date(year, month, 1);
  let startOffset = firstOfMonth.getDay() - 1; // Pazartesi ilk sütun olsun
  if (startOffset < 0) startOffset = 6;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const today = new Date();
  const isToday = (y, m, d) => today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;

  const cardsByDay = {};
  for (const c of state.cards) {
    const d = new Date(c.due_date);
    if (isNaN(d)) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    (cardsByDay[key] = cardsByDay[key] || []).push(c);
  }

  const cells = [];
  for (let i = startOffset; i > 0; i--) {
    const dnum = daysInPrevMonth - i + 1;
    cells.push({ y: month === 0 ? year - 1 : year, m: month === 0 ? 11 : month - 1, d: dnum, other: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ y: year, m: month, d, other: false });
  }
  let nextDay = 1;
  while (cells.length < 42) {
    cells.push({ y: month === 11 ? year + 1 : year, m: month === 11 ? 0 : month + 1, d: nextDay++, other: true });
  }

  const gridHtml = cells
    .map((c) => {
      const key = `${c.y}-${c.m}-${c.d}`;
      const dayCards = (cardsByDay[key] || []).slice(0, 4);
      const extra = (cardsByDay[key] || []).length - dayCards.length;
      const pills = dayCards
        .map((card) => {
          const color = card.is_overdue ? "var(--red)" : `var(--${STATUSES.find((s) => s.key === card.status)?.dot || "amber"})`;
          return `<div class="calendar-pill" data-id="${card.id}" style="background:${color}" title="${escapeHtml(card.description)}">${escapeHtml(card.description.slice(0, 18))}</div>`;
        })
        .join("");
      return `
        <div class="calendar-day ${c.other ? "is-other-month" : ""} ${isToday(c.y, c.m, c.d) ? "is-today" : ""}">
          <div class="calendar-day__num">${c.d}</div>
          ${pills}
          ${extra > 0 ? `<div style="font-size:9px;color:var(--paper-muted)">+${extra} daha</div>` : ""}
        </div>
      `;
    })
    .join("");

  body.innerHTML = `
    <div class="calendar-header">
      <button class="calendar-nav-btn" id="calPrevBtn" type="button">‹</button>
      <h4>${monthNames[month]} ${year}</h4>
      <button class="calendar-nav-btn" id="calNextBtn" type="button">›</button>
    </div>
    <div class="calendar-grid">
      ${dayLabels.map((l) => `<div class="calendar-daylabel">${l}</div>`).join("")}
      ${gridHtml}
    </div>
  `;

  document.getElementById("calPrevBtn").addEventListener("click", () => {
    state.calendarMonth = new Date(year, month - 1, 1);
    renderCalendar();
  });
  document.getElementById("calNextBtn").addEventListener("click", () => {
    state.calendarMonth = new Date(year, month + 1, 1);
    renderCalendar();
  });
  body.querySelectorAll(".calendar-pill").forEach((el) => {
    el.addEventListener("click", () => {
      closeModal("calendarModal");
      openDetail(Number(el.dataset.id));
    });
  });
}

// ---------------- Kullanıcılar (admin) ----------------

async function openUsers() {
  try {
    const users = await api("/api/users");
    renderUsers(users);
    openModalEl("usersModal");
  } catch (err) {
    if (err.message !== "unauthorized") flash(displayError(err));
  }
}

function renderUsers(users) {
  const body = document.getElementById("usersBody");
  const rows = users
    .map(
      (u) => `
    <div class="user-row" data-id="${u.id}">
      <div>
        <div class="user-row__name">${escapeHtml(u.display_name)}</div>
        <div class="user-row__username">@${escapeHtml(u.username)}</div>
      </div>
      <select data-field="role" ${u.id === state.me.id ? "disabled" : ""}>
        <option value="istek_sahibi" ${u.role === "istek_sahibi" ? "selected" : ""}>İstek Sahibi</option>
        <option value="sosyal_medya" ${u.role === "sosyal_medya" ? "selected" : ""}>Sosyal Medya Ekibi</option>
      </select>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--paper-muted)">
        <input type="checkbox" data-field="is_admin" ${u.is_admin ? "checked" : ""} ${u.id === state.me.id ? "disabled" : ""} /> Yönetici
      </label>
      <span class="user-row__spacer"></span>
      <span class="status-pill ${u.is_active ? "status-pill--active" : "status-pill--inactive"}">${u.is_active ? "Aktif" : "Devre dışı"}</span>
      ${u.id === state.me.id ? "" : `<button class="btn btn--ghost" data-action="toggle-active" style="padding:6px 12px;font-size:12px">${u.is_active ? "Devre dışı bırak" : "Yeniden etkinleştir"}</button>`}
    </div>
  `
    )
    .join("");

  body.innerHTML = `
    <div>${rows}</div>
    <div class="new-user-form">
      <h4 style="margin:0 0 10px;font-size:13px;color:var(--paper-muted);font-weight:700">Yeni kullanıcı ekle</h4>
      <div class="field-row">
        <label class="field"><span>Adı</span><input type="text" id="nu_display_name" /></label>
        <label class="field"><span>Kullanıcı adı</span><input type="text" id="nu_username" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Şifre</span><input type="password" id="nu_password" /></label>
        <label class="field">
          <span>Rol</span>
          <select id="nu_role">
            <option value="istek_sahibi">İstek Sahibi</option>
            <option value="sosyal_medya">Sosyal Medya Ekibi</option>
          </select>
        </label>
      </div>
      <p class="authError" id="usersError"></p>
      <button class="btn btn--primary" type="button" id="btnAddUser">Kullanıcı ekle</button>
    </div>
  `;

  body.querySelectorAll(".user-row").forEach((row) => {
    const id = Number(row.dataset.id);
    row.querySelector('[data-field="role"]').addEventListener("change", async (e) => {
      try {
        await apiJson(`/api/users/${id}`, "PATCH", { role: e.target.value });
        flash("Rol güncellendi.");
      } catch (err) {
        flash(displayError(err));
        openUsers();
      }
    });
    row.querySelector('[data-field="is_admin"]')?.addEventListener("change", async (e) => {
      try {
        await apiJson(`/api/users/${id}`, "PATCH", { is_admin: e.target.checked });
        flash("Güncellendi.");
      } catch (err) {
        flash(displayError(err));
        openUsers();
      }
    });
    row.querySelector('[data-action="toggle-active"]')?.addEventListener("click", async () => {
      const isActive = row.querySelector(".status-pill").textContent.trim() === "Aktif";
      try {
        if (isActive) {
          await api(`/api/users/${id}`, { method: "DELETE" });
        } else {
          await apiJson(`/api/users/${id}`, "PATCH", { is_active: true });
        }
        openUsers();
      } catch (err) {
        flash(displayError(err));
      }
    });
  });

  onClickGuarded(document.getElementById("btnAddUser"), async () => {
    const errEl = document.getElementById("usersError");
    errEl.textContent = "";
    try {
      await apiJson("/api/users", "POST", {
        display_name: document.getElementById("nu_display_name").value.trim(),
        username: document.getElementById("nu_username").value.trim(),
        password: document.getElementById("nu_password").value,
        role: document.getElementById("nu_role").value,
        is_admin: false,
      });
      flash("Kullanıcı eklendi.");
      openUsers();
    } catch (err) {
      errEl.textContent = displayError(err);
    }
  });
}

// ---------------- Filtre çubuğu ----------------

function initFilterBar() {
  document.getElementById("filterBrand").innerHTML =
    `<option value="">Tüm markalar</option>` + BRANDS.map((b) => `<option value="${b.key}">${escapeHtml(b.label)}</option>`).join("");
  document.getElementById("filterPlatform").innerHTML =
    `<option value="">Tüm platformlar</option>` + PLATFORMS.map((p) => `<option value="${p.key}">${escapeHtml(p.label)}</option>`).join("");

  document.getElementById("filterSearch").addEventListener("input", (e) => {
    state.filters.search = e.target.value.trim().toLowerCase();
    renderBoard();
  });
  document.getElementById("filterBrand").addEventListener("change", (e) => {
    state.filters.brand = e.target.value;
    renderBoard();
  });
  document.getElementById("filterPlatform").addEventListener("change", (e) => {
    state.filters.platform = e.target.value;
    renderBoard();
  });
  document.getElementById("filterAssignee").addEventListener("change", (e) => {
    state.filters.assignee = e.target.value;
    renderBoard();
  });
  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    state.filters = { search: "", brand: "", platform: "", assignee: "" };
    document.getElementById("filterSearch").value = "";
    document.getElementById("filterBrand").value = "";
    document.getElementById("filterPlatform").value = "";
    document.getElementById("filterAssignee").value = "";
    renderBoard();
  });
}

// ---------------- Başlat ----------------

function init() {
  initAuthForms();
  initModalClose();
  initCreateModal();
  initFilterBar();
  document.getElementById("openHistoryBtn").addEventListener("click", openHistory);
  document.getElementById("openUsersBtn").addEventListener("click", openUsers);
  document.getElementById("exportCsvBtn").addEventListener("click", () => {
    window.location.href = "/api/export/csv";
  });
  document.getElementById("downloadBackupBtn").addEventListener("click", () => {
    window.location.href = "/api/backup";
  });
  document.getElementById("openCalendarBtn").addEventListener("click", openCalendar);
  boot();
}

document.addEventListener("DOMContentLoaded", init);
