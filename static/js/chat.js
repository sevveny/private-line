/**
 * chat.js
 * --------
 * Клиентская логика чата поверх Flask-SocketIO:
 *   - отправка/получение/удаление/редактирование сообщений в реальном времени;
 *   - статусы "отправлено / доставлено / прочитано";
 *   - "Онлайн" / "был(а) в сети ...";
 *   - индикатор "печатает...";
 *   - реакции эмодзи;
 *   - ответы на сообщения (цитаты) с переходом по клику;
 *   - плавная прокрутка, которая не сбивает пользователя, читающего историю.
 */

(function () {
    const config = window.CHAT_CONFIG;
    const socket = io();

    // --- Ссылки на DOM-элементы -------------------------------------------

    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("message-input");
    const sendBtn = document.getElementById("send-btn");
    const typingEl = document.getElementById("typing-indicator");
    const statusPill = document.getElementById("status-pill");
    const otherNode = document.getElementById("other-node");
    const wireEl = document.getElementById("wire");
    const scrollJumpBtn = document.getElementById("scroll-jump");
    const replyPreviewEl = document.getElementById("reply-preview");
    const replyPreviewAuthorEl = document.getElementById("reply-preview-author");
    const replyPreviewTextEl = document.getElementById("reply-preview-text");
    const replyPreviewCloseBtn = document.getElementById("reply-preview-close");

    // --- Состояние клиента ---------------------------------------------------

    let replyingTo = null;                 // {id, author, text} | null
    let otherOnline = config.otherOnlineInitial;
    let otherLastSeenRaw = config.otherLastSeenRaw;
    // Карта "какую реакцию поставил именно текущий пользователь" — message_id -> emoji.
    const ownReactions = Object.assign({}, config.ownReactions || {});
    // Чтобы не слать mark_read повторно на одно и то же сообщение.
    const sentReadRequests = new Set();

    // -------------------------------------------------------------
    // Утилиты
    // -------------------------------------------------------------

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str == null ? "" : String(str);
        return div.innerHTML;
    }

    function pad2(n) {
        return String(n).padStart(2, "0");
    }

    function formatTime(createdAt) {
        return (createdAt || "").includes("T") ? createdAt.split("T")[1] : createdAt;
    }

    function isNearBottom() {
        return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
    }

    function scrollToBottom(smooth) {
        messagesEl.scrollTo({
            top: messagesEl.scrollHeight,
            behavior: smooth ? "smooth" : "auto",
        });
    }

    // -------------------------------------------------------------
    // "Был(а) в сети ..." — форматирование и периодическое обновление
    // -------------------------------------------------------------

    function formatLastSeen(iso) {
        if (!iso) return null;
        const dt = new Date(iso);
        const now = new Date();
        const diffMs = now - dt;

        if (diffMs < 60000) return "был(а) в сети только что";

        const sameDay = dt.toDateString() === now.toDateString();
        if (sameDay) {
            const diffMin = Math.floor(diffMs / 60000);
            if (diffMin < 60) return `был(а) в сети ${diffMin} мин. назад`;
            return `сегодня в ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
        }

        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        if (dt.toDateString() === yesterday.toDateString()) {
            return `вчера в ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
        }

        return `был(а) в сети ${pad2(dt.getDate())}.${pad2(dt.getMonth() + 1)}.${dt.getFullYear()} в ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
    }

    function updateStatusPill() {
        if (!config.otherUsername) {
            statusPill.textContent = "собеседник не подключён";
            return;
        }
        if (otherOnline) {
            statusPill.textContent = "онлайн";
            return;
        }
        statusPill.textContent = formatLastSeen(otherLastSeenRaw) || "офлайн";
    }

    // Обновляем текст "N минут назад" раз в 30 секунд, даже если событий не было.
    setInterval(updateStatusPill, 30000);

    // -------------------------------------------------------------
    // Рендер сообщения (используется для новых сообщений, пришедших по сокету;
    // разметка идентична серверному Jinja-макросу render_message в chat.html)
    // -------------------------------------------------------------

    function buildReplyBlockHtml(reply) {
        if (!reply) return "";
        if (reply.deleted) {
            return `
                <div class="reply-quote reply-quote-deleted" data-reply-target="">
                    <span class="reply-quote-bar"></span>
                    <div class="reply-quote-body">
                        <span class="reply-quote-label">↩ Ответ на:</span>
                        <span class="reply-quote-text">Сообщение удалено</span>
                    </div>
                </div>`;
        }
        return `
            <div class="reply-quote" data-reply-target="${reply.id}">
                <span class="reply-quote-bar"></span>
                <div class="reply-quote-body">
                    <span class="reply-quote-label">↩ Ответ на:</span>
                    <span class="reply-quote-author">${escapeHtml(reply.username)}:</span>
                    <span class="reply-quote-text">${escapeHtml(reply.content)}</span>
                </div>
            </div>`;
    }

    function buildReactionsBarHtml(reactions, messageId) {
        const activeEmoji = ownReactions[messageId];
        return Object.entries(reactions || {}).map(([emoji, count]) => `
            <button class="reaction-chip ${activeEmoji === emoji ? "active" : ""}" data-emoji="${emoji}">
                <span class="reaction-emoji">${emoji}</span><span class="reaction-count">${count}</span>
            </button>
        `).join("");
    }

    function buildToolbarHtml(isOwn) {
        const pickerButtons = config.allowedReactions.map(
            (emoji) => `<button class="reaction-option" data-emoji="${emoji}">${emoji}</button>`
        ).join("");

        return `
            <div class="message-toolbar">
                <button class="toolbar-btn" data-action="reply">Ответить</button>
                ${isOwn ? '<button class="toolbar-btn" data-action="edit">Изменить</button>' : ""}
                ${isOwn ? '<button class="toolbar-btn toolbar-btn-danger" data-action="delete">Удалить</button>' : ""}
                <span class="reaction-picker">${pickerButtons}</span>
            </div>`;
    }

    function buildStatusHtml(isOwn, status) {
        if (!isOwn) return "";
        return `
            <div class="message-status" data-status="${status}" title="${status}">
                <span class="tick tick-1">✓</span><span class="tick tick-2">✓</span>
            </div>`;
    }

    function buildMessageElement(m) {
        const isOwn = m.user_id === config.userId;

        const wrapper = document.createElement("div");
        wrapper.className = "message new-message " + (isOwn ? "own" : "foreign");
        wrapper.dataset.id = m.id;
        wrapper.dataset.status = m.status;
        wrapper.dataset.author = m.user_id;

        wrapper.innerHTML = `
            <div class="message-meta">
                <span class="message-author">${escapeHtml(m.username)}</span>
                <span class="message-time">${escapeHtml(formatTime(m.created_at))}</span>
            </div>
            ${buildReplyBlockHtml(m.reply)}
            <div class="message-bubble">
                <span class="message-text">${escapeHtml(m.content)}</span>
                ${m.edited_at ? '<span class="edited-label">(изменено)</span>' : ""}
            </div>
            ${buildToolbarHtml(isOwn)}
            <div class="message-footer">
                <div class="reactions-bar">${buildReactionsBarHtml(m.reactions, m.id)}</div>
                ${buildStatusHtml(isOwn, m.status)}
            </div>
        `;

        return wrapper;
    }

    function appendMessage(m) {
        const isOwn = m.user_id === config.userId;
        const wasNearBottom = isNearBottom();

        const el = buildMessageElement(m);
        messagesEl.appendChild(el);

        if (isOwn || wasNearBottom) {
            scrollToBottom(true);
            hideScrollJump();
        } else {
            showScrollJump();
        }

        // Если сообщение сразу оказалось видно — попробуем отметить его прочитанным.
        scanVisibleForeignForRead();
    }

    // -------------------------------------------------------------
    // Плавающая кнопка "новое сообщение"
    // -------------------------------------------------------------

    function showScrollJump() {
        scrollJumpBtn.hidden = false;
    }

    function hideScrollJump() {
        scrollJumpBtn.hidden = true;
    }

    scrollJumpBtn.addEventListener("click", () => {
        scrollToBottom(true);
        hideScrollJump();
        scanVisibleForeignForRead();
    });

    let scrollDebounce = null;
    messagesEl.addEventListener("scroll", () => {
        clearTimeout(scrollDebounce);
        scrollDebounce = setTimeout(() => {
            if (isNearBottom()) hideScrollJump();
            scanVisibleForeignForRead();
        }, 150);
    });

    // -------------------------------------------------------------
    // "Прочитано": сообщение считается прочитанным, если оно физически
    // видно во вьюпорте ленты и вкладка находится в фокусе.
    // -------------------------------------------------------------

    function scanVisibleForeignForRead() {
        if (document.hidden || !document.hasFocus()) return;

        const containerRect = messagesEl.getBoundingClientRect();
        const candidates = [];

        messagesEl.querySelectorAll(".message.foreign").forEach((el) => {
            const id = el.dataset.id;
            if (sentReadRequests.has(id)) return;

            const rect = el.getBoundingClientRect();
            const visible = rect.bottom > containerRect.top && rect.top < containerRect.bottom;
            if (visible) {
                candidates.push(id);
                sentReadRequests.add(id);
            }
        });

        if (candidates.length) {
            socket.emit("mark_read", { message_ids: candidates.map(Number) });
        }
    }

    window.addEventListener("focus", scanVisibleForeignForRead);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) scanVisibleForeignForRead();
    });

    // -------------------------------------------------------------
    // Отправка сообщений (в т.ч. ответов)
    // -------------------------------------------------------------

    function sendMessage() {
        const content = inputEl.value.trim();
        if (!content) return;

        const payload = { content };
        if (replyingTo) payload.reply_to_id = replyingTo.id;

        socket.emit("send_message", payload);
        inputEl.value = "";
        clearReply();
        stopTyping();
    }

    sendBtn.addEventListener("click", sendMessage);

    inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            sendMessage();
        }
    });

    socket.on("new_message", (message) => {
        appendMessage(message);
    });

    // -------------------------------------------------------------
    // Ответы на сообщения
    // -------------------------------------------------------------

    function setReply(messageEl) {
        const id = parseInt(messageEl.dataset.id, 10);
        const author = messageEl.querySelector(".message-author").textContent;
        const text = messageEl.querySelector(".message-text").textContent;

        replyingTo = { id, author, text };
        replyPreviewAuthorEl.textContent = author;
        replyPreviewTextEl.textContent = text;
        replyPreviewEl.hidden = false;
        inputEl.focus();
    }

    function clearReply() {
        replyingTo = null;
        replyPreviewEl.hidden = true;
    }

    replyPreviewCloseBtn.addEventListener("click", clearReply);

    function scrollToOriginal(targetId) {
        const target = messagesEl.querySelector(`.message[data-id="${targetId}"]`);
        if (!target) return;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("highlight");
        setTimeout(() => target.classList.remove("highlight"), 1200);
    }

    // -------------------------------------------------------------
    // Редактирование сообщений
    // -------------------------------------------------------------

    function startEdit(messageEl) {
        const bubble = messageEl.querySelector(".message-bubble");
        if (bubble.dataset.editing === "1") return;

        // Закрываем другое открытое редактирование, если оно было.
        document.querySelectorAll('.message-bubble[data-editing="1"]').forEach((b) => cancelEdit(b));

        const currentText = messageEl.querySelector(".message-text").textContent;
        bubble.dataset.editing = "1";
        bubble.dataset.originalHtml = bubble.innerHTML;

        bubble.innerHTML = `
            <input type="text" class="edit-input" value="${escapeHtml(currentText)}">
            <div class="edit-actions">
                <button type="button" class="edit-save">Сохранить</button>
                <button type="button" class="edit-cancel">Отмена</button>
            </div>`;

        const input = bubble.querySelector(".edit-input");
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }

    function cancelEdit(bubble) {
        if (bubble.dataset.editing !== "1") return;
        bubble.innerHTML = bubble.dataset.originalHtml;
        delete bubble.dataset.editing;
        delete bubble.dataset.originalHtml;
    }

    function saveEdit(messageEl, bubble) {
        const input = bubble.querySelector(".edit-input");
        const value = input.value.trim();
        if (!value) return;

        socket.emit("edit_message", {
            message_id: parseInt(messageEl.dataset.id, 10),
            content: value,
        });
        // UI обновится, когда придёт подтверждение "message_edited" от сервера.
    }

    socket.on("message_edited", (data) => {
        const messageEl = messagesEl.querySelector(`.message[data-id="${data.message_id}"]`);
        if (!messageEl) return;

        const bubble = messageEl.querySelector(".message-bubble");
        bubble.innerHTML = `
            <span class="message-text">${escapeHtml(data.content)}</span>
            <span class="edited-label">(изменено)</span>`;
        delete bubble.dataset.editing;
        delete bubble.dataset.originalHtml;

        // Если это сообщение кто-то цитирует, обновим текст цитаты у обоих.
        document.querySelectorAll(`.reply-quote[data-reply-target="${data.message_id}"] .reply-quote-text`)
            .forEach((el) => { el.textContent = data.content; });
    });

    // -------------------------------------------------------------
    // Удаление сообщений
    // -------------------------------------------------------------

    socket.on("message_deleted", (data) => {
        const el = messagesEl.querySelector(`.message[data-id="${data.message_id}"]`);
        if (el) {
            el.classList.add("deleting");
            setTimeout(() => el.remove(), 200);
        }

        // Все цитаты на удалённое сообщение превращаются в "Сообщение удалено".
        document.querySelectorAll(`.reply-quote[data-reply-target="${data.message_id}"]`).forEach((quote) => {
            quote.classList.add("reply-quote-deleted");
            quote.removeAttribute("data-reply-target");
            quote.querySelector(".reply-quote-author")?.remove();
            const textEl = quote.querySelector(".reply-quote-text");
            if (textEl) textEl.textContent = "Сообщение удалено";
        });
    });

    // -------------------------------------------------------------
    // Реакции
    // -------------------------------------------------------------

    function toggleReaction(messageId, emoji) {
        socket.emit("toggle_reaction", { message_id: messageId, emoji });
    }

    socket.on("reactions_update", (data) => {
        if (data.actor_id === config.userId) {
            if (data.actor_emoji) {
                ownReactions[data.message_id] = data.actor_emoji;
            } else {
                delete ownReactions[data.message_id];
            }
        }

        const messageEl = messagesEl.querySelector(`.message[data-id="${data.message_id}"]`);
        if (!messageEl) return;

        const bar = messageEl.querySelector(".reactions-bar");
        bar.innerHTML = buildReactionsBarHtml(data.reactions, data.message_id);
        bar.classList.add("pop");
        setTimeout(() => bar.classList.remove("pop"), 220);
    });

    // -------------------------------------------------------------
    // Статусы сообщений: отправлено / доставлено / прочитано
    // -------------------------------------------------------------

    socket.on("status_update", (data) => {
        data.message_ids.forEach((id) => {
            const messageEl = messagesEl.querySelector(`.message[data-id="${id}"]`);
            if (!messageEl) return;

            messageEl.dataset.status = data.status;
            const statusEl = messageEl.querySelector(".message-status");
            if (statusEl) {
                statusEl.dataset.status = data.status;
                statusEl.title = data.status;
            }
        });
    });

    // -------------------------------------------------------------
    // Делегированные обработчики кликов в ленте сообщений
    // -------------------------------------------------------------

    messagesEl.addEventListener("click", (e) => {
        const messageEl = e.target.closest(".message");

        // Клик по цитате -> переходим к оригиналу
        const quote = e.target.closest(".reply-quote[data-reply-target]");
        if (quote && quote.dataset.replyTarget) {
            scrollToOriginal(quote.dataset.replyTarget);
            return;
        }

        // Клик по реакции в панели-подборе или по уже существующему счётчику
        const reactionBtn = e.target.closest(".reaction-option, .reaction-chip");
        if (reactionBtn && messageEl) {
            toggleReaction(parseInt(messageEl.dataset.id, 10), reactionBtn.dataset.emoji);
            return;
        }

        // Кнопки панели действий
        const actionBtn = e.target.closest("[data-action]");
        if (actionBtn && messageEl) {
            const action = actionBtn.dataset.action;
            if (action === "reply") setReply(messageEl);
            if (action === "edit") startEdit(messageEl);
            if (action === "delete") socket.emit("delete_message", { message_id: parseInt(messageEl.dataset.id, 10) });
            return;
        }

        // Кнопки сохранения/отмены редактирования
        if (e.target.closest(".edit-save") && messageEl) {
            saveEdit(messageEl, messageEl.querySelector(".message-bubble"));
            return;
        }
        if (e.target.closest(".edit-cancel") && messageEl) {
            cancelEdit(messageEl.querySelector(".message-bubble"));
            return;
        }

        // Тап по самому сообщению — раскрыть/скрыть панель действий (для мобильных)
        if (e.target.closest(".message-bubble") && messageEl) {
            document.querySelectorAll(".message.toolbar-open").forEach((el) => {
                if (el !== messageEl) el.classList.remove("toolbar-open");
            });
            messageEl.classList.toggle("toolbar-open");
        }
    });

    // Enter/Escape при редактировании
    messagesEl.addEventListener("keydown", (e) => {
        if (!e.target.classList.contains("edit-input")) return;
        const messageEl = e.target.closest(".message");
        const bubble = e.target.closest(".message-bubble");
        if (e.key === "Enter") {
            e.preventDefault();
            saveEdit(messageEl, bubble);
        } else if (e.key === "Escape") {
            cancelEdit(bubble);
        }
    });

    // -------------------------------------------------------------
    // Индикатор "печатает..."
    // -------------------------------------------------------------

    let typingTimeout = null;
    let isTypingSent = false;

    inputEl.addEventListener("input", () => {
        if (!isTypingSent) {
            socket.emit("typing", { is_typing: true });
            isTypingSent = true;
        }
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(stopTyping, 2000);
    });

    function stopTyping() {
        if (isTypingSent) {
            socket.emit("typing", { is_typing: false });
            isTypingSent = false;
        }
        clearTimeout(typingTimeout);
    }

    socket.on("typing", (data) => {
        if (data.is_typing) {
            typingEl.textContent = `${data.username} печатает…`;
            typingEl.classList.add("visible");
        } else {
            typingEl.classList.remove("visible");
        }
    });

    // -------------------------------------------------------------
    // Присутствие: онлайн / офлайн / был(а) в сети
    // -------------------------------------------------------------

    socket.on("presence_update", (data) => {
        if (data.user_id === config.userId) return; // событие про нас самих — игнорируем

        otherOnline = data.online;
        otherLastSeenRaw = data.last_seen;
        updateStatusPill();

        if (data.online) {
            otherNode.classList.add("online");
            wireEl.classList.add("live");
        } else {
            otherNode.classList.remove("online");
            wireEl.classList.remove("live");
        }
    });

    // -------------------------------------------------------------
    // Инициализация при загрузке страницы
    // -------------------------------------------------------------

    scrollToBottom(false);
    scanVisibleForeignForRead();
})();
