// ==UserScript==
// @name         Poke Idle World - Quality of Life (PIW-QOL) - KizaniN
// @namespace    http://tampermonkey.net/
// @version      10.6.1
// @description  Mercado e Depot fora das hunts, retorno rápido à cidade, buscas de itens e auto-reconnect resiliente.
// @author       Desjunior (JulianoCLI)
// @updater      KizaniN
// @match        https://poke.idleworld.online/play*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/mateuspedro/Poke-Idle-World-Quality-of-Life-Kizano
// @supportURL   https://github.com/mateuspedro/Poke-Idle-World-Quality-of-Life-Kizano/issues
// @updateURL    https://raw.githubusercontent.com/mateuspedro/Poke-Idle-World-Quality-of-Life-Kizano/main/qql.user.js
// @downloadURL  https://raw.githubusercontent.com/mateuspedro/Poke-Idle-World-Quality-of-Life-Kizano/main/qql.user.js
// ==/UserScript==

(function() {
    'use strict';

    const NativeWebSocket = window.WebSocket;
    const nativeWebSocketSend = NativeWebSocket.prototype.send;
    let gameSocket = null;
    let latestInventory = null;
    let latestPokemon = null;
    let latestFamily = null;
    const gameEventWaiters = new Map();
    const trackedGameSockets = new WeakSet();
    let lastSocketMessageAt = Date.now();
    let lastHuntSocketActivityAt = Date.now();
    let lastAutoReconnectAt = 0;
    let autoReconnectInProgress = false;
    let lastCaptureBarSignature = '';
    let autoReconnectWasInHunt = false;
    let lastKnownHuntContextAt = 0;
    let huntActivityRevision = 0;
    let consecutiveReconnectFailures = 0;
    let nextAutoReconnectAt = 0;
    let lastAnalyzerXp = null;
    let lastAnalyzerXpChangeAt = Date.now();
    let itemLockCache = new Set();
    let pokemonLockCache = new Set();
    let locksLoaded = false;
    const GAME_SOCKET_MESSAGE_TYPES = new Set(['inventory', 'family', 'pokes', 'pokes-get']);

    function isInHuntContext() {
        if (document.querySelector('[data-guide="capture-bar"], .hunt-ui, .battle-window, .wild-pokemon')) return true;
        const location = getCurrentHuntLocation?.() || currentHuntSnapshot?.locName || '';
        if (location && !isKnownNonHuntLocation(location)) return true;
        const analyzer = document.querySelector('.ha-window:not(.ha-compare-modal)');
        return Boolean(analyzer && !isCityName(getLastHunt()));
    }

    function isHuntProgressMessage(message) {
        const type = String(message?.type || '').toLowerCase();
        if (/chat|family|friend|ranking|pong|ping|inventory|pokes-get/.test(type)) return false;
        if (/exp|xp|defeat|kill|loot|drop|capture|catch|damage|attack/.test(type)) return true;
        const payload = JSON.stringify(message).toLowerCase();
        return /"(?:expgained|xpgain|xp|experience|defeated|killed|damage|loot|drops?|reward)"\s*:\s*(?:[1-9]\d*|true|\[|\{)/.test(payload);
    }
    function resetAutoReconnectFailures() {
        consecutiveReconnectFailures = 0;
        nextAutoReconnectAt = 0;
    }

    function markConfirmedHuntActivity(at = Date.now()) {
        lastHuntSocketActivityAt = at;
        huntActivityRevision += 1;
        resetAutoReconnectFailures();
        if (!bossMaxLogged) cancelScheduledAutoReconnectReload();
    }

async function loadNativeLocks() {
    if (locksLoaded) return;
    try {
        const data = await gameApiRequest('/api/game/item/lock');
        itemLockCache = new Set((data?.locked || []).map(String));
        locksLoaded = true;
    } catch (error) {
        console.warn('Falha ao carregar cadeados nativos:', error);
    }
}

function isItemLocked(itemId) {
    return itemLockCache.has(String(itemId));
}

function setItemLocked(itemId, locked) {
    const id = String(itemId);
    if (locked) itemLockCache.add(id);
    else itemLockCache.delete(id);
}

async function toggleNativeItemLock(itemId, locked) {
    const result = await gameApiRequest('/api/game/item/lock', {
        method: 'POST',
        body: JSON.stringify({ itemId: Number(itemId), locked })
    });
    setItemLocked(itemId, locked);
    return result;
}

async function toggleNativePokemonLock(pokemonId, locked) {
    const result = await gameApiRequest('/api/game/pokemon/lock', {
        method: 'POST',
        body: JSON.stringify({ id: pokemonId, locked })
    });
    if (result?.ok) {
        if (locked) pokemonLockCache.add(String(pokemonId));
        else pokemonLockCache.delete(String(pokemonId));
    }
    return result;
}

    function handleCapturedPokemon(message) {
        const name = message?.speciesName
            || message?.name
            || message?.pokemonName
            || message?.poke?.name
            || message?.pokemon?.name
            || '';
        const cleanName = getCleanHuntName(name);
        if (!cleanName) return;
        if (message?.success === false) return;

        if (!globalCaughtPokemonNames.has(cleanName)) {
            globalCaughtPokemonNames.add(cleanName);
            saveCaughtPokemonCache();
            lastMapRenderSignature = '';
            setTimeout(buildSimpleList, 0);
        }

        loadCaughtPokedexData(true);
    }
    function handleGameSocketMessage(event, socket) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        lastSocketMessageAt = Date.now();
        const huntMessage = isHuntSocketMessage(message);
        if (huntMessage || GAME_SOCKET_MESSAGE_TYPES.has(String(message?.type || ''))) {
            gameSocket = socket;
        }
        if (isBossSignalType(message?.type)) markBossContext('mensagem do jogo');
        if (huntMessage) markConfirmedHuntActivity();
        if (message?.type === 'inventory') latestInventory = message.items || [];
        if (message?.type === 'family') latestFamily = message;
        if (message?.type === 'pokes') {
            latestPokemon = message.list || [];
            if (updateCachedLeaderPokemon(latestPokemon)) {
                lastMapRenderSignature = '';
                setTimeout(buildSimpleList, 0);
            }
            setTimeout(enhanceCaptureLog, 0);
            setTimeout(enhancePartyQuality, 0);
        }

        if (message?.type === 'catch-result') {
            handleCapturedPokemon(message);
        }
        const waiters = gameEventWaiters.get(message?.type);
        if (waiters) {
            gameEventWaiters.delete(message.type);
            waiters.forEach(resolve => resolve(message));
        }
    }

    function trackGameSocket(socket, url = socket?.url) {
        if (!socket || !String(url || '').includes('/ws')) return socket;
        if (!gameSocket || gameSocket.readyState !== NativeWebSocket.OPEN) gameSocket = socket;
        if (trackedGameSockets.has(socket)) return socket;
        trackedGameSockets.add(socket);
        socket.addEventListener('message', event => handleGameSocketMessage(event, socket));
        socket.addEventListener('close', () => {
            if (gameSocket === socket) gameSocket = null;
        });
        return socket;
    }

    function TrackedWebSocket(url, protocols) {
        const socket = protocols === undefined
            ? new NativeWebSocket(url)
            : new NativeWebSocket(url, protocols);
        return trackGameSocket(socket, url);
    }
    TrackedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(TrackedWebSocket, NativeWebSocket);
    window.WebSocket = TrackedWebSocket;
    NativeWebSocket.prototype.send = function(data) {
        trackGameSocket(this);
        observeOutgoingGameMessage(this, data);
        return nativeWebSocketSend.call(this, data);
    };

    function sendGameMessage(message) {
        if (!gameSocket || gameSocket.readyState !== NativeWebSocket.OPEN) return false;
        gameSocket.send(JSON.stringify(message));
        return true;
    }

    async function waitForGameSocket(timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (gameSocket?.readyState === NativeWebSocket.OPEN) return true;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return gameSocket?.readyState === NativeWebSocket.OPEN;
    }

    const HUNT_SILENCE_MS = 30000;
    const HUNT_REENTRY_DELAY_MS = 500;
    const HUNT_REENTRY_CONFIRM_MS = 30000;
    const RECONNECT_COOLDOWN_MS = 5000;
    const RECONNECT_CHECK_INTERVAL_MS = 1000;
    const RECONNECT_BACKOFF_STEPS_MS = [10000, 20000, 40000];
    const RECONNECT_MAX_ATTEMPTS = RECONNECT_BACKOFF_STEPS_MS.length + 1;
    const SOCKET_DOWN_RELOAD_MS = 45000;
    const HUNT_CONTEXT_LOSS_GRACE_MS = 5 * 60 * 1000;
    const HUNT_MESSAGE_TYPES = new Set(['field', 'field-init', 'field-kill', 'poke-xp', 'pending', 'catch-result']);

    let currentHuntSlug = null;
    let huntSlugRestored = false;
    let socketDownSince = 0;
    let reloadScheduled = false;
    let reloadTimerId = null;
    let lastHuntNameRefreshAt = 0;
    let missingSlugLogged = false;

    const BOSS_SIGNAL_PATTERN = /boss|raid/i;
    const BOSS_BROADCAST_PATTERN = /rank|chat|announ|notif|list|shop|market|token|reward|histor|log/i;
    const BOSS_DOM_SELECTOR = [
        '[data-guide*="boss" i]',
        '[data-guide*="raid" i]',
        '.boss-window',
        '.boss-ui',
        '.boss-battle',
        '.raid-window',
        '.raid-ui'
    ].join(',');
    const BOSS_CONTEXT_TTL_MS = 60000;
    const BOSS_CONTEXT_MAX_MS = 5 * 60 * 1000;
    let bossContextUntil = 0;
    let bossContextStartedAt = 0;
    let bossMaxLogged = false;

    function markBossContext(source) {
        const now = Date.now();
        const wasActive = bossContextUntil > Date.now();
        if (!bossContextStartedAt) bossContextStartedAt = now;
        bossContextUntil = now + BOSS_CONTEXT_TTL_MS;
        if (!wasActive && isAutoReconnectActive()) {
            logAutoReconnectStatus(`Boss detectada (${source}); em espera até a luta terminar.`);
        }
    }

    function isBossSignalType(type) {
        const clean = String(type || '');
        return BOSS_SIGNAL_PATTERN.test(clean) && !BOSS_BROADCAST_PATTERN.test(clean);
    }

    function hasBossInterface() {
        return Boolean(document.querySelector(BOSS_DOM_SELECTOR));
    }

    function isBossContext() {
        if (bossContextUntil > Date.now()) return true;
        if (hasBossInterface()) {
            markBossContext('interface');
            return true;
        }
        bossContextStartedAt = 0;
        bossMaxLogged = false;
        return false;
    }

    function isBossSafetyExpired() {
        return Boolean(bossContextStartedAt && Date.now() - bossContextStartedAt >= BOSS_CONTEXT_MAX_MS);
    }

    function isHuntSocketMessage(message) {
        return HUNT_MESSAGE_TYPES.has(String(message?.type || '')) || isHuntProgressMessage(message);
    }

    function rememberHuntSlug(slug) {
        const clean = String(slug || '').trim();
        if (!clean) return;
        missingSlugLogged = false;
        currentHuntSlug = clean;
        huntSlugRestored = true;
        sessionStorage.setItem(STORAGE_RECONNECT_TAB_SLUG, clean);
    }

    function getRememberedHuntSlug() {
        if (!huntSlugRestored) {
            huntSlugRestored = true;
            currentHuntSlug = currentHuntSlug
                || sessionStorage.getItem(STORAGE_RECONNECT_TAB_SLUG)
                || null;
            localStorage.removeItem('script_reconnect_pending_v1');
        }
        return currentHuntSlug;
    }

    async function resolveCurrentHuntSlug() {
        const location = getCurrentHuntLocation();
        if (!location) return getRememberedHuntSlug();
        if (isKnownNonHuntLocation(location)) return null;
        await loadMapMarkersData();
        const marker = findMappedHunt(location);
        if (marker && isCityMarker(marker, location)) return null;
        const slug = getMarkerSlug(marker);
        if (slug) {
            rememberHuntSlug(slug);
            return slug;
        }
        return globalHuntMarkerData.size ? null : getRememberedHuntSlug();
    }

    function observeOutgoingGameMessage(socket, data) {
        if (!String(socket?.url || '').includes('/ws') || typeof data !== 'string') return;
        let message;
        try {
            message = JSON.parse(data);
        } catch {
            return;
        }
        if (message?.type === 'enter-hunt' || message?.type === 'leave-hunt') gameSocket = socket;
        if (isBossSignalType(message?.type)) markBossContext('ação do jogador');
        if (message?.type === 'enter-hunt' && message.slug) {
            rememberHuntSlug(message.slug);
            lastHuntSocketActivityAt = Date.now();
        }
    }

    function logAutoReconnectStatus(message, isError = false) {
        const logger = isError ? console.warn : console.info;
        logger(`[PIW-QOL] Auto-reconnect: ${message}`);
    }

    function cancelScheduledAutoReconnectReload() {
        if (reloadTimerId !== null) clearTimeout(reloadTimerId);
        reloadTimerId = null;
        reloadScheduled = false;
    }

    function scheduleAutoReconnectReload(message, delayMs = 1500) {
        if (reloadScheduled) return false;
        reloadScheduled = true;
        logAutoReconnectStatus(message, true);
        reloadTimerId = setTimeout(() => {
            reloadTimerId = null;
            if (!isAutoReconnectActive()) {
                reloadScheduled = false;
                return;
            }
            location.reload();
        }, delayMs);
        return true;
    }

    async function waitForHuntRecovery(activityRevision, timeoutMs = HUNT_REENTRY_CONFIRM_MS) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!gameSocket || gameSocket.readyState !== NativeWebSocket.OPEN) return false;
            if (huntActivityRevision > activityRevision) return true;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
    }

    function registerReconnectFailure(slug) {
        consecutiveReconnectFailures += 1;
        lastHuntSocketActivityAt = Date.now();

        if (consecutiveReconnectFailures >= RECONNECT_MAX_ATTEMPTS) {
            scheduleAutoReconnectReload(
                `A reentrada em ${slug} não foi confirmada após ${consecutiveReconnectFailures} tentativas; recarregando a página.`
            );
            return;
        }

        const backoffMs = RECONNECT_BACKOFF_STEPS_MS[consecutiveReconnectFailures - 1];
        nextAutoReconnectAt = Date.now() + backoffMs;
        logAutoReconnectStatus(
            `A reentrada em ${slug} não produziu atividade da hunt. Nova tentativa em ${Math.round(backoffMs / 1000)} segundos `
            + `(${consecutiveReconnectFailures}/${RECONNECT_MAX_ATTEMPTS}).`,
            true
        );
    }

    async function rejoinCurrentHunt(reason) {
        if (autoReconnectInProgress || isBossContext()) return false;
        autoReconnectInProgress = true;
        lastAutoReconnectAt = Date.now();
        try {
            const slug = await resolveCurrentHuntSlug();
            if (!slug) {
                if (isKnownNonHuntLocation(getCurrentHuntLocation())) return false;
                if (!missingSlugLogged) {
                    missingSlugLogged = true;
                    logAutoReconnectStatus('A hunt atual não pôde ser identificada; entre nela de novo pelo mapa.', true);
                }
                nextAutoReconnectAt = Date.now() + 60000;
                return false;
            }
            missingSlugLogged = false;
            lastHuntSocketActivityAt = Date.now();
            if (!sendGameMessage({ type: 'leave-hunt' })) {
                logAutoReconnectStatus('WebSocket indisponível para sair da hunt.', true);
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, HUNT_REENTRY_DELAY_MS));
            const activityRevisionBeforeEnter = huntActivityRevision;
            const captureBarBeforeEnter = document.querySelector('[data-guide="capture-bar"]')?.innerHTML || '';
            const entered = sendGameMessage({ type: 'enter-hunt', slug });
            lastHuntSocketActivityAt = Date.now();
            lastCaptureBarSignature = captureBarBeforeEnter;
            if (!entered) {
                logAutoReconnectStatus(`${reason} O reenvio de enter-hunt para ${slug} falhou.`, true);
                return false;
            }

            const confirmed = await waitForHuntRecovery(activityRevisionBeforeEnter);
            if (confirmed) {
                resetAutoReconnectFailures();
                logAutoReconnectStatus(`${reason} Reentrada em ${slug} confirmada pelo jogo.`);
                return true;
            }
            if (!gameSocket || gameSocket.readyState !== NativeWebSocket.OPEN) {
                logAutoReconnectStatus(`O WebSocket caiu enquanto a reentrada em ${slug} era confirmada.`, true);
                return false;
            }
            registerReconnectFailure(slug);
            return false;
        } catch (error) {
            logAutoReconnectStatus(`Falha inesperada ao reentrar na hunt: ${error?.message || error}`, true);
            if (gameSocket?.readyState === NativeWebSocket.OPEN) registerReconnectFailure(currentHuntSlug || 'hunt atual');
            return false;
        } finally {
            autoReconnectInProgress = false;
        }
    }

    setInterval(async () => {
        const now = Date.now();
        const captureBar = document.querySelector('[data-guide="capture-bar"]');
        const socketOpen = gameSocket?.readyState === NativeWebSocket.OPEN;
        const currentLocation = getCurrentHuntLocation();
        const knownNonHuntLocation = isKnownNonHuntLocation(currentLocation);
        const inHunt = isInHuntContext();

        if (knownNonHuntLocation) {
            autoReconnectWasInHunt = false;
            lastKnownHuntContextAt = 0;
            socketDownSince = 0;
            resetAutoReconnectFailures();
            return;
        }

        if (inHunt) {
            lastKnownHuntContextAt = now;
            if (!autoReconnectWasInHunt) {
                autoReconnectWasInHunt = true;
                lastHuntSocketActivityAt = now;
                resetAutoReconnectFailures();
                return;
            }
        } else {
            const mayRecoverMissingInterface = autoReconnectWasInHunt
                && !socketOpen
                && now - lastKnownHuntContextAt <= HUNT_CONTEXT_LOSS_GRACE_MS;
            if (!mayRecoverMissingInterface) {
                autoReconnectWasInHunt = false;
                lastKnownHuntContextAt = 0;
                socketDownSince = 0;
                resetAutoReconnectFailures();
                return;
            }
        }

        if (!isAutoReconnectActive()) {
            socketDownSince = 0;
            return;
        }
        if (autoReconnectInProgress) return;
        if (isBossContext()) {
            lastHuntSocketActivityAt = now;
            socketDownSince = 0;
            resetAutoReconnectFailures();
            if (isBossSafetyExpired() && (hasBossInterface() || !socketOpen) && !bossMaxLogged) {
                bossMaxLogged = true;
                scheduleAutoReconnectReload('A interface da boss permaneceu ativa por cinco minutos; recarregando sem enviar leave-hunt.');
            }
            return;
        }
        if (now - lastHuntNameRefreshAt >= 5000) {
            lastHuntNameRefreshAt = now;
            rememberCurrentHuntFromHud();
        }

        if (!socketOpen) {
            if (!socketDownSince) {
                socketDownSince = now;
                logAutoReconnectStatus('WebSocket caiu; aguardando a reconexão do jogo.', true);
            } else if (now - socketDownSince >= SOCKET_DOWN_RELOAD_MS) {
                scheduleAutoReconnectReload('WebSocket continua fechado; recarregando a página.');
            }
            return;
        }
        socketDownSince = 0;

        const captureBarSignature = captureBar?.innerHTML || '';
        if (captureBar && captureBarSignature !== lastCaptureBarSignature) {
            lastCaptureBarSignature = captureBarSignature;
            markConfirmedHuntActivity(now);
        }
        if (now - lastHuntSocketActivityAt < HUNT_SILENCE_MS) return;
        if (now - lastAutoReconnectAt < RECONNECT_COOLDOWN_MS) return;
        if (now < nextAutoReconnectAt) return;
        if (isKnownNonHuntLocation(currentLocation)) return;
        await rejoinCurrentHunt('Hunt sem resposta por 30 segundos.');
    }, RECONNECT_CHECK_INTERVAL_MS);

    async function requestFreshGameEvent(type, requestType, { timeoutMs = 3500, attempts = 2 } = {}) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const result = await requestGameEvent(type, requestType, null, timeoutMs);
            if (type === 'family') {
                if (result && !Array.isArray(result) && result.type === 'family') return result;
            } else if (Array.isArray(result)) {
                return result;
            }
        }
        return type === 'family' ? null : [];
    }

    function requestGameEvent(type, requestType, cachedValue, timeoutMs = 2500) {
        if (cachedValue) return Promise.resolve(cachedValue);
        return new Promise(resolve => {
            const waiters = gameEventWaiters.get(type) || [];
            const waiter = message => resolve(
                type === 'inventory' ? message.items || []
                    : type === 'family' ? message
                        : message.list || []
            );
            waiters.push(waiter);
            gameEventWaiters.set(type, waiters);
            const request = typeof requestType === 'string' ? { type: requestType } : requestType;
            if (!sendGameMessage(request)) {
                gameEventWaiters.set(type, waiters.filter(item => item !== waiter));
                resolve([]);
                return;
            }
            setTimeout(() => {
                const pending = gameEventWaiters.get(type) || [];
                gameEventWaiters.set(type, pending.filter(item => item !== waiter));
                resolve([]);
            }, timeoutMs);
        });
    }

    const STORAGE_FAVS = 'hunts_favoritas_v1';
    const STORAGE_LAST_HUNT = 'ultima_hunt_v1';
    const STORAGE_SCRIPT_ACTIVE = 'script_mapa_ativo_v1';
    const STORAGE_CHAT_ACTIVE = 'script_chat_ativo_v1';
    const STORAGE_NAV_MODE = 'script_nav_tp_mode_v1';
    const STORAGE_DROP_MODE = 'script_drop_mode_v1';
    const STORAGE_SELL_CONFIRM = 'script_sell_confirm_items_v1';
    const STORAGE_SELL_LOCKS = 'script_sell_locks_v1';
    const STORAGE_NATIVE_ITEM_LOCKS = 'script_native_item_locks_v1';
    const STORAGE_DEX_FAST_TRAVEL = 'script_dex_fast_travel_v1';
    const STORAGE_GUARD_LEGENDARY = 'script_guard_legendary_v1';
    const STORAGE_HA_COMPACT = 'script_ha_compact_v1';
    const STORAGE_HA_DROPS = 'script_ha_drops_v1';
    const STORAGE_DEX_FILTER = 'script_dex_filter_v1';
    const STORAGE_DEX_SORT_VALUE = 'script_dex_sort_value_v1';
    const STORAGE_CAUGHT_POKEMON = 'script_caught_pokemon_v1';
    const STORAGE_HUNT_BULK_BUY = 'script_hunt_bulk_buy_v1';
    const STORAGE_HUNT_SELL = 'script_hunt_sell_v1';
    const STORAGE_MARK_ENHANCEMENTS = 'script_mark_enhancements_v1';
    const STORAGE_MAP_FILTERS = 'script_map_filters_v1';
    const STORAGE_HA_HISTORY = 'script_ha_history_v1';
    const STORAGE_PRIMARY_FAVORITE = 'script_primary_favorite_v1';
    const STORAGE_GAME_FONT = 'script_game_font_v1';
    const STORAGE_AUTO_RECONNECT = 'script_auto_reconnect_v1';
    const STORAGE_RECONNECT_TAB_SLUG = 'script_reconnect_hunt_slug_tab_v1';
    const STORAGE_CUSTOM_SCROLLBARS = 'script_custom_scrollbars_v1';
    const STORAGE_UNIFIED_FONTS = 'script_unified_fonts_v1';
    const STORAGE_COMPARE_WINDOW = 'script_compare_window_v1';
    const STORAGE_MARK_QUICK_BUY = 'script_mark_quick_buy_v1';
    const STORAGE_MARK_QUALITY_PICKER = 'script_mark_quality_picker_v1';
    const STORAGE_SHOW_QUALITY_POTENTIAL = 'script_show_quality_potential_v1';
    const STORAGE_SHOW_POKEMON_SELL_ICON = 'script_show_pokemon_sell_icon_v1';
    const STORAGE_CUSTOM_FONT = 'script_custom_font_v1';
    const STORAGE_CUSTOM_FONT_NAME = 'script_custom_font_name_v1';
    const CUSTOM_FONT_FAMILY = 'PIW Uploaded Font';

    const GAME_FONT_OPTIONS = {
        barlow: 'Barlow, "Barlow Fallback", system-ui, sans-serif',
        verdana: 'Verdana, Geneva, sans-serif',
        arial: 'Arial, Helvetica, sans-serif',
        system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        cinzel: 'Cinzel, "Cinzel Fallback", serif'
    };

    function getGameFont() { return localStorage.getItem(STORAGE_GAME_FONT) || 'barlow'; }
    function getCustomFont() { return localStorage.getItem(STORAGE_CUSTOM_FONT) || ''; }
    function openCustomFontDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('piw-qol-assets', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('assets');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    async function storeCustomFontFile(buffer) {
        const database = await openCustomFontDatabase();
        await new Promise((resolve, reject) => {
            const transaction = database.transaction('assets', 'readwrite');
            transaction.objectStore('assets').put(buffer, 'custom-font');
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
        database.close();
    }
    async function loadStoredCustomFont() {
        try {
            const database = await openCustomFontDatabase();
            const buffer = await new Promise((resolve, reject) => {
                const request = database.transaction('assets').objectStore('assets').get('custom-font');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            database.close();
            if (!buffer) return false;
            const face = new FontFace(CUSTOM_FONT_FAMILY, buffer);
            await face.load();
            document.fonts.add(face);
            if (getGameFont() === 'custom') applyGameFont('custom');
            return true;
        } catch (error) {
            console.warn('Não foi possível carregar a fonte personalizada:', error);
            return false;
        }
    }
    function applyGameFont(value = getGameFont()) {
        const key = value === 'custom' || GAME_FONT_OPTIONS[value] ? value : 'barlow';
        localStorage.setItem(STORAGE_GAME_FONT, key);
        const custom = getCustomFont().replace(/[;{}]/g, '').trim();
        document.documentElement.style.setProperty('--piw-game-font', key === 'custom' && custom ? custom : GAME_FONT_OPTIONS[key === 'custom' ? 'barlow' : key]);
    }
    function isAutoReconnectActive() { return localStorage.getItem(STORAGE_AUTO_RECONNECT) === 'true'; }
    const OPT_IN_PREFERENCES = new Set([STORAGE_SHOW_QUALITY_POTENTIAL]);
    const preferenceEnabled = key => OPT_IN_PREFERENCES.has(key)
        ? localStorage.getItem(key) === 'true'
        : localStorage.getItem(key) !== 'false';
    function applyVisualPreferences() {
        document.documentElement.classList.toggle('script-custom-scrollbars', preferenceEnabled(STORAGE_CUSTOM_SCROLLBARS));
        document.documentElement.classList.toggle('script-unified-fonts', preferenceEnabled(STORAGE_UNIFIED_FONTS));
    }

    let isRendering = false;
    let cachedTrainerLevel = null;
    let trainerLevelPromise = null;
    let lastMapRenderSignature = '';
    let cachedLeaderPokemonName = '';
    let cachedLeaderPokemonTypes = [];
    const globalCreatureApiData = new Map();
    const globalItemApiData = new Map();
    const globalHuntMarkerData = new Map();
    const globalCaughtPokemonNames = new Set(loadCaughtPokemonCache());
    let mapMarkersLoadPromise = null;
    let itemDataLoadPromise = null;

    function escapeHTML(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        })[char]);
    }

    function getGameLanguage() {
        const candidates = [
            localStorage.getItem('i18nextLng'),
            localStorage.getItem('pokeweb:language'),
            localStorage.getItem('language'),
            localStorage.getItem('locale'),
            document.documentElement.lang,
            navigator.language
        ].filter(Boolean);
        const detected = candidates
            .map(value => String(value).replace(/^["']|["']$/g, ''))
            .find(value => /^(?:pt|en)(?:-|_|$)/i.test(value));
        return /^pt(?:-|_|$)/i.test(detected || '') ? 'pt' : 'en';
    }

    const SCRIPT_I18N = {
        pt: {
            scriptMods: 'Mods do Script', modSettings: 'Configurações do Mod',
            enabled: 'Ligado', disabled: 'Desligado', simplifiedMap: 'Mapa simplificado',
            simplifiedMapDesc: 'Ativa a lista limpa ou restaura o mapa gráfico nativo.',
            dropsPreview: 'Visualização dos drops', dropsPreviewDesc: 'Escolha como ver os itens na lista do mapa.',
            hidden: 'Oculto', icon: 'Ícone (?)', navAction: 'Ação do botão de teleporte',
            navActionDesc: 'Define a ação do botão de teleporte na barra do jogo.', favorite: 'Favorita', last: 'Última', none: 'Desativado',
            chatInterface: 'Interface do chat', chatInterfaceDesc: 'Exibe ou oculta a janela de chat.',
            show: 'Exibir', hide: 'Ocultar', dexFastTravelDesc: 'Exibe o Fast Travel na Pokédex.',
            enableDexFastTravel: 'Habilitar ⚡ Fast Travel na Pokédex', selectAllGuards: 'Proteções do Selecionar tudo',
            selectAllGuardsDesc: 'Proteções aplicadas ao selecionar tudo nas abas.',
            protectLegendary: 'Desmarcar Pokémon lendários (aba Pokémon)',
            sellConfirmation: 'Itens com confirmação de venda',
            huntFeatures: 'Recursos da Hunt', huntFeaturesDesc: 'Escolha quais melhorias aparecem enquanto estiver em uma hunt.',
            bulkBuy: 'Compras +1.000/+10.000', bulkBuyDesc: 'Adiciona quantidades grandes à loja de Poké Bolas.',
            huntSell: 'Venda na Hunt', huntSellDesc: 'Permite vender itens e Pokémon pela loja da hunt.',
            cityMark: 'Melhorias do Mark', cityMarkDesc: 'Quantidades, cadeados e confirmações na loja da cidade.',
            bestHunt: 'Verificar melhor hunt',
            globalMarket: 'Mercado Global', items: 'Itens', pokemon: 'Pokémon', refresh: 'Atualizar',
            shops: 'Lojas', ballShop: 'Loja de Poké Bolas', sellItems: 'Vender itens e Pokémon',
            search: 'Buscar...', loading: 'Carregando anúncios…', noListings: 'Nenhum anúncio encontrado.',
            showing: 'Exibindo', of: 'de', loadMore: 'Carregar mais',
            inStock: 'em estoque',
            buy: 'Comprar', offerOnly: 'Oferta', ivTotal: 'IV total', showOffers: 'Mostrar ofertas',
            all: 'Todos', stones: 'Stones', pokeBalls: 'Poké Balls', diamonds: 'Diamonds', currency: 'Moeda', gold: 'Dólar',
            recent: 'Mais recentes', lowestPrice: 'Menor preço', highestPrice: 'Maior preço',
            highestIv: 'Maior IV', highestPower: 'Maior poder', highestLevel: 'Maior nível', highestQuality: 'Maior qualidade',
            shinyOnly: 'Somente shiny', minIv: 'IV mín.', maxIv: 'IV máx.', minLevel: 'Nível mín.', maxLevel: 'Nível máx.', minQuality: 'Qual. mín.', maxQuality: 'Qual. máx.', allTypes: 'Todos os tipos',
            purchaseDone: 'Compra concluída.', purchaseFailed: 'Não foi possível concluir a compra.',
            loadFailed: 'Não foi possível carregar o mercado.', seller: 'Vendedor', quantity: 'Quantidade',
            price: 'Preço', selectItems: 'Selecionar itens ▾', protectedItems: 'Itens protegidos. Busque ao lado para adicionar.',
            noProtected: 'Nenhum item protegido', noItemFound: 'Nenhum item encontrado'
        },
        en: {
            scriptMods: 'Script Mods', modSettings: 'Mod Settings',
            enabled: 'Enabled', disabled: 'Disabled', simplifiedMap: 'Simplified Map',
            simplifiedMapDesc: 'Enables the clean list or restores the native graphical map.',
            dropsPreview: 'Drops Preview', dropsPreviewDesc: 'Choose how items appear in the map list.',
            hidden: 'Hidden', icon: 'Icon (?)', navAction: 'Teleport Button Action',
            navActionDesc: 'Defines the teleport button action in the game dock.', favorite: 'Favorite', last: 'Last', none: 'Disabled',
            chatInterface: 'Chat Interface', chatInterfaceDesc: 'Shows or hides the chat window.',
            show: 'Show', hide: 'Hide', dexFastTravelDesc: 'Shows the Fast Travel option in the Pokédex.',
            enableDexFastTravel: 'Enable ⚡ Fast Travel in the Pokédex', selectAllGuards: 'Select All Guards',
            selectAllGuardsDesc: 'Protections applied when using Select All in tabs.',
            protectLegendary: 'Deselect legendary Pokémon (Pokémon tab)',
            sellConfirmation: 'Sell Confirmation Items',
            huntFeatures: 'Hunt Features', huntFeaturesDesc: 'Choose which enhancements are available while inside a hunt.',
            bulkBuy: '+1,000/+10,000 purchases', bulkBuyDesc: 'Adds large quantities to the Poké Ball shop.',
            huntSell: 'Hunt Selling', huntSellDesc: 'Sell items and Pokémon from the hunt shop.',
            cityMark: 'Mark Enhancements', cityMarkDesc: 'Quantities, locks and confirmations in the city shop.',
            bestHunt: 'Check best hunt',
            globalMarket: 'Global Market', items: 'Items', pokemon: 'Pokémon', refresh: 'Refresh',
            shops: 'Shops', ballShop: 'Poké Ball Shop', sellItems: 'Sell items and Pokémon',
            search: 'Search...', loading: 'Loading listings…', noListings: 'No listings found.',
            showing: 'Showing', of: 'of', loadMore: 'Load more',
            inStock: 'in stock',
            buy: 'Buy', offerOnly: 'Offer', ivTotal: 'Total IV', showOffers: 'Show offers',
            all: 'All', stones: 'Stones', pokeBalls: 'Poké Balls', diamonds: 'Diamonds', currency: 'Currency', gold: 'Dollar',
            recent: 'Most recent', lowestPrice: 'Lowest price', highestPrice: 'Highest price',
            highestIv: 'Highest IV', highestPower: 'Highest power', highestLevel: 'Highest level', highestQuality: 'Highest quality',
            shinyOnly: 'Shiny only', minIv: 'Min IV', maxIv: 'Max IV', minLevel: 'Min level', maxLevel: 'Max level', minQuality: 'Min quality', maxQuality: 'Max quality', allTypes: 'All types',
            purchaseDone: 'Purchase completed.', purchaseFailed: 'Could not complete the purchase.',
            loadFailed: 'Could not load the market.', seller: 'Seller', quantity: 'Quantity',
            price: 'Price', selectItems: 'Select items ▾', protectedItems: 'Protected items. Search to add more.',
            noProtected: 'No protected items', noItemFound: 'No item found'
        }
    };
    function tr(key) { return SCRIPT_I18N[getGameLanguage()][key] || SCRIPT_I18N.en[key] || key; }

    function readStoredJSON(key, fallback) {
        const stored = localStorage.getItem(key);
        if (!stored) return fallback;
        try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed) ? parsed : fallback;
        } catch (error) {
            console.warn(`Falha ao ler a configuração "${key}". O valor padrão será usado.`, error);
            return fallback;
        }
    }

    const DEFAULT_MAP_FILTERS = {
        sort: '',
        type: '',
        access: 'all',
        captured: '',
        search: '',
        levelMin: '',
        levelMax: ''
    };

    function getMapFilters() {
        const stored = localStorage.getItem(STORAGE_MAP_FILTERS);
        if (!stored) return { ...DEFAULT_MAP_FILTERS };
        try {
            const parsed = JSON.parse(stored);
            return { ...DEFAULT_MAP_FILTERS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
        } catch {
            return { ...DEFAULT_MAP_FILTERS };
        }
    }

    function setMapFilters(filters) {
        const merged = { ...DEFAULT_MAP_FILTERS, ...(filters || {}) };
        localStorage.setItem(STORAGE_MAP_FILTERS, JSON.stringify(merged));
    }

    function clearMapFilters() {
        localStorage.removeItem(STORAGE_MAP_FILTERS);
    }

    function simplifyNativeMapControls(mapWindow) {
        if (!mapWindow) return;
        const typeNames = new Set([
            'aço', 'água', 'dragão', 'elétrico', 'fada', 'fantasma', 'fogo', 'gelo',
            'inseto', 'lutador', 'normal', 'pedra', 'planta', 'psíquico', 'sombrio',
            'terra', 'veneno', 'voador',
            'steel', 'water', 'dragon', 'electric', 'fairy', 'ghost', 'fire', 'ice',
            'bug', 'fighting', 'rock', 'grass', 'psychic', 'dark', 'ground', 'poison', 'flying'
        ]);
        const normalize = value => String(value || '').normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
        const normalizedTypes = new Set([...typeNames].map(normalize));
        const candidates = Array.from(mapWindow.querySelectorAll('div, section, nav'))
            .map(element => ({
                element,
                matches: Array.from(element.children).filter(child =>
                    normalizedTypes.has(normalize(child.textContent.replace(/[^\p{L}]/gu, '')))
                ).length
            }))
            .filter(candidate => candidate.matches >= 8)
            .sort((a, b) => a.element.getBoundingClientRect().height - b.element.getBoundingClientRect().height);
        candidates[0]?.element.classList.add('script-hidden-native-types');
    }

    function readTrainerLevelFromDOM() {
        const candidates = [
            document.querySelector('.phud-tlevel'),
            document.querySelector('.phud-level'),
            document.querySelector('[data-guide="player-level"]')
        ].filter(Boolean);
        for (const element of candidates) {
            const match = element.textContent.match(/\d+/);
            if (match) return Number(match[0]);
        }
        return null;
    }

    function loadTrainerLevel(force = false) {
        const domLevel = readTrainerLevelFromDOM();
        if (domLevel) cachedTrainerLevel = domLevel;
        if (!force && (cachedTrainerLevel !== null || trainerLevelPromise)) {
            return trainerLevelPromise || Promise.resolve(cachedTrainerLevel);
        }
        trainerLevelPromise = gameApiRequest('/api/characters/me')
            .then(payload => {
                cachedTrainerLevel = Number(payload?.character?.level ?? payload?.level) || readTrainerLevelFromDOM() || 1;
                return cachedTrainerLevel;
            })
            .catch(() => {
                cachedTrainerLevel = readTrainerLevelFromDOM() || 1;
                return cachedTrainerLevel;
            })
            .finally(() => { trainerLevelPromise = null; });
        return trainerLevelPromise;
    }

    function hasPiwToolsStats(pokemon) {
        return Boolean(pokemon?.stats) && ['hp', 'atk', 'def', 'spAtk', 'spDef', 'speed']
            .every(stat => Number.isFinite(Number(pokemon.stats[stat])));
    }

    function requestPokemonTeamFromGameContext(timeoutMs = 1800) {
        const hudElement = document.querySelector('.phud-name') || document.querySelector('.phud');
        if (!hudElement) return Promise.resolve([]);
        const fiberKey = Object.keys(hudElement).find(key => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? hudElement[fiberKey] : null;
        let gameContext = null;
        for (let depth = 0; fiber && depth < 30; depth++, fiber = fiber.return) {
            const value = fiber.memoizedProps?.value;
            if (value && typeof value.subscribe === 'function' && typeof value.requestPokes === 'function') {
                gameContext = value;
                break;
            }
        }
        if (!gameContext) return Promise.resolve([]);

        return new Promise(resolve => {
            let settled = false;
            let unsubscribe = null;
            const finish = list => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                try { unsubscribe?.(); } catch {}
                resolve(Array.isArray(list) ? list : []);
            };
            const timeout = setTimeout(() => finish([]), timeoutMs);
            unsubscribe = gameContext.subscribe('pokes', message => finish(message?.list));
            gameContext.requestPokes();
        });
    }

    function getGameContextFromDOM() {
        const hudElement = document.querySelector('.phud-name') || document.querySelector('.phud');
        const fiberKey = hudElement && Object.keys(hudElement).find(key => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? hudElement[fiberKey] : null;
        for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
            const value = fiber.memoizedProps?.value;
            if (value && typeof value.subscribe === 'function') return value;
        }
        return null;
    }

    async function toggleNativeLock(kind, entry) {
        const context = getGameContextFromDOM();
        const id = entry?.id ?? entry?.capturedId ?? entry?.itemId;
        const nextLocked = !isNativeLocked(entry);
        if (kind === 'item') {
            const itemId = Number(entry?.itemId ?? entry?.id);
            if (!Number.isFinite(itemId)) throw new Error('O item não possui um identificador válido.');
            await gameApiRequest('/api/game/item/lock', {
                method: 'POST',
                body: JSON.stringify({ itemId, locked: nextLocked })
            });
            entry.locked = nextLocked;
            entry.isLocked = nextLocked;
            setNativeItemLock(entry.name, nextLocked);
            return nextLocked;
        }
        const candidates = kind === 'pokemon'
            ? ['togglePokeLock', 'togglePokemonLock', 'setPokeLocked', 'lockPoke']
            : [];
        const method = candidates.find(name => typeof context?.[name] === 'function');
        if (method) {
            await context[method](id, nextLocked);
        } else {
            const sent = sendGameMessage({ type: kind === 'pokemon' ? 'poke-lock' : 'item-lock', [kind === 'pokemon' ? 'pokeId' : 'itemId']: id, locked: nextLocked });
            if (!sent) throw new Error('A ação nativa de cadeado não está disponível.');
        }
        entry.locked = nextLocked;
        return nextLocked;
    }
function isNativeLocked(entry) {
    if (entry?.locked ?? entry?.isLocked ?? entry?.protected ?? entry?.sellLocked) return true;
    const id = entry?.id ?? entry?.itemId ?? entry?.capturedId;
    if (id == null) return false;
    return itemLockCache.has(String(id)) || pokemonLockCache.has(String(id));
}

    async function getCompleteLeaderPokemon() {
        let pokemonList = await requestPokemonTeamFromGameContext();
        if (!pokemonList.some(hasPiwToolsStats)) {
            pokemonList = Array.isArray(latestPokemon) ? latestPokemon : [];
        }
        let leader = pokemonList.find(pokemon => pokemon.leader)
            || pokemonList.filter(pokemon => pokemon.team)
                .sort((a, b) => Number(a.slot ?? 99) - Number(b.slot ?? 99))[0];
        return hasPiwToolsStats(leader) ? leader : null;
    }

    function openExternalLink(url) {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    }

    async function openBestHuntForLeader() {
        try {
            const [leader, characterPayload] = await Promise.all([
                getCompleteLeaderPokemon(),
                gameApiRequest('/api/characters/me')
            ]);
            const stats = leader?.stats;
            if (!leader || !stats) {
                throw new Error('Não foi possível identificar os atributos do Pokémon principal.');
            }

            const level = Math.max(1, Number(leader.level) || 1);
            const params = new URLSearchParams({
                pokemon: getCleanHuntName(leader.name),
                level: String(level),
                hp: String(stats.hp),
                atk: String(stats.atk),
                def: String(stats.def),
                spatk: String(stats.spAtk),
                spdef: String(stats.spDef),
                speed: String(stats.speed),
                tab: 'route',
                routeTarget: String(300)
            });

            const character = characterPayload?.character || characterPayload || {};
            if (character.clan) {
                params.set('clan', String(character.clan).trim().toLowerCase());
                if (Number(character.clanRank) > 0) params.set('clanRank', String(character.clanRank));
            }

            const url = `https://piwtools.com.br/hunt?${params.toString()}`;
            openExternalLink(url);
        } catch (error) {
            showScriptNotice(error.message || 'Não foi possível gerar o link para o PIW Tools.', {
                title: 'Melhor hunt',
                isError: true
            });
        }
    }

    function parseGameNumber(value) {
        const text = String(value ?? '').trim().toLowerCase();
        const abbreviated = text.match(/(-?\d+(?:[.,]\d+)?)\s*([kmb])\b/);
        if (abbreviated) {
            const number = Number(abbreviated[1].replace(',', '.'));
            const multipliers = { k: 1e3, m: 1e6, b: 1e9 };
            return Number.isFinite(number) ? Math.round(number * multipliers[abbreviated[2]]) : 0;
        }
        const digits = text.replace(/[^0-9-]/g, '');
        const parsed = parseInt(digits, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function refreshDexEnhancements() {
        const dexWindow = document.querySelector('.dex-window');
        if (!dexWindow) return;
        const controls = dexWindow.querySelector('.dex-script-controls');
        if (controls) controls.remove();
        injectDexEnhancements();
    }

    const POKEMON_TYPES_JSON_URL = 'https://poke.idleworld.online/game/creatures.json';
    const ITEMS_JSON_URL = 'https://poke.idleworld.online/game/items.json';
    const MAP_MARKERS_API_URL = '/api/game/map-markers';
    const POKEMON_ITEM_ICONS = {1:36575,2:36585,3:36595,4:36605,5:36615,6:36625,7:36634,8:36643,9:36651,10:36669,11:36660,12:36702,13:36696,14:36687,15:36705,16:36722,17:36713,18:36731,19:36740,20:36755,21:36758,22:36767,23:36776,24:36785,25:36639,26:36647,27:36601,28:36611,29:36586,30:36606,31:36596,32:36576,33:36626,34:36616,35:36644,36:36635,37:36674,38:36683,39:36620,40:36630,41:36580,42:36590,43:36717,44:36726,45:36735,46:36652,47:36661,48:36670,49:36900,50:36688,51:36697,52:36723,53:36714,54:36656,55:36665,56:36706,57:36759,58:36782,59:36741,60:36732,61:36768,62:36786,63:36691,64:36700,65:36709,66:36771,67:36780,68:36789,69:36777,70:36577,71:36587,72:36676,73:36685,74:36744,75:36753,76:36762,77:36597,78:36607,79:36617,80:36627,81:36631,82:36640,83:36636,84:36692,85:36701,86:36799,87:36653,88:36655,89:36641,90:36671,91:36662,92:36680,93:36689,94:36698,95:36707,96:36715,97:36724,98:36592,99:36733,100:36694,101:36703,102:36751,103:36760,104:36769,105:36778,106:36737,107:36648,108:36588,109:36673,110:36682,111:36710,112:36718,113:36598,114:36608,115:36618,116:36781,117:36738,118:36745,119:36754,120:36581,121:36591,122:36628,123:36637,124:36645,125:36622,126:36663,127:36621,128:36672,129:36711,130:36720,131:36681,132:36690,133:36699,134:36708,135:36716,136:36725,137:36734,138:36743,139:36752,140:36761,141:36770,142:36779,143:36788,147:36629,148:36638,149:36646,150:36609};

    function getPokemonIconUrl(speciesId) {
        const id = Number(speciesId);
        if (id >= 152 && id <= 251 && id !== 201) return `/assets/pokeitems/gen2/${id}.png`;
        if ((id >= 252 && id <= 386) || id === 447 || id === 448) return `/assets/pokeitems/gen3/${id}.png`;
        return POKEMON_ITEM_ICONS[id] ? `/assets/pokeitems/${POKEMON_ITEM_ICONS[id]}.png` : '';
    }

    function getPokemonIconUrlByName(name) {
        const pokemon = globalCreatureApiData.get(getCleanHuntName(name));
        return getPokemonIconUrl(pokemon?.speciesId ?? pokemon?.pokeId ?? pokemon?.id);
    }

    function updateCachedLeaderPokemon(pokemonList) {
        const leader = pokemonList.find(pokemon => pokemon.leader)
            || pokemonList.filter(pokemon => pokemon.team).sort((a, b) => Number(a.slot ?? 99) - Number(b.slot ?? 99))[0];
        if (!leader) return false;
        const name = normalizePokemonName(leader.name || leader.pokemonName || '');
        const explicitTypes = [leader.type1, leader.type2, ...(Array.isArray(leader.types) ? leader.types : [])]
            .filter(Boolean).map(type => String(type).toLowerCase());
        const types = explicitTypes.length ? [...new Set(explicitTypes)] : (POKEMON_TYPES[name] || []);
        const changed = name !== cachedLeaderPokemonName || JSON.stringify(types) !== JSON.stringify(cachedLeaderPokemonTypes);
        cachedLeaderPokemonName = name;
        cachedLeaderPokemonTypes = types;
        return changed;
    }

    async function refreshActivePokemonForMap() {
        let pokemonList = await requestPokemonTeamFromGameContext(2200);
        if (!pokemonList.length) pokemonList = Array.isArray(latestPokemon) ? latestPokemon : [];
        return updateCachedLeaderPokemon(pokemonList);
    }

    function normalizeGameItemIcon(icon) {
        if (!icon) return '';
        if (/^(https?:)?\//.test(icon)) return icon;
        return `/assets/items/${String(icon).replace(/^\/+/, '')}`;
    }

    const KNOWN_STONE_ICON_URLS = {
        fire_stone: '/assets/items/fire_stone.gif',
        feather_stone: '/assets/stones/feather_stone.png',
        leaf_stone: '/assets/items/leaf_stone.gif',
        rock_stone: '/assets/items/rock_stone.gif',
        enigma_stone: '/assets/items/enigma_stone.gif',
        cocoon_stone: '/assets/items/cocoon_stone.gif',
        thunder_stone: '/assets/items/thunder_stone.gif',
        earth_stone: '/assets/items/earth_stone.gif',
        crystal_stone: '/assets/items/crystal_stone.gif',
        metal_stone: '/assets/stones/metal_stone.png',
        ancient_stone: '/assets/stones/ancient_stone.gif',
        water_stone: '/assets/items/water_stone.gif',
        heart_stone: '/assets/items/heart_stone.gif',
        skull_stone: '/assets/items/skull_stone.png',
        ice_stone: '/assets/items/ice_stone.gif',
        punch_stone: '/assets/items/punch_stone.gif',
        darkness_stone: '/assets/items/darkness_stone.gif',
        venom_stone: '/assets/items/venom_stone.gif',
        deep_stone: '/assets/items/deep_stone.png',
        flower_stone: '/assets/items/flower_stone.png',
        aqua_stone: '/assets/items/aqua_stone.png',
        champion_stone: '/assets/items/champion_stone.png',
        voltage_stone: '/assets/items/voltage_stone.png',
        pixie_stone: '/assets/items/pixie_stone.png',
        tortoise_stone: '/assets/items/tortoise_stone.png',
        aroma_stone: '/assets/items/aroma_stone.png'
    };

    function getMarketItemIconHTML(name, entry, ref, category) {
        const cleanName = String(name || '').trim().toLowerCase();
        if (cleanName === 'diamonds' || String(category || '').toLowerCase() === 'diamonds') {
            return '<span class="market-item-emoji" aria-hidden="true">💎</span>';
        }
        if (/\bstone\b/.test(cleanName) || /stones?/i.test(category)) {
            const stoneKey = cleanName.replace(/\s+/g, '_');
            const stoneSlug = encodeURIComponent(stoneKey);
            const [firstSource, ...fallbackSources] = [...new Set([
                KNOWN_STONE_ICON_URLS[stoneKey],
                `/assets/stones/${stoneSlug}.png`,
                `/assets/stones/${stoneSlug}.gif`,
                `/assets/items/${stoneSlug}.gif`,
                `/assets/items/${stoneSlug}.png`
            ].filter(Boolean))];
            return `<img class="market-item-icon" src="${firstSource}" data-icon-fallbacks="${escapeHTML(JSON.stringify(fallbackSources))}" alt="">`;
        }
        if (cleanName === 'idle ball') {
            return '<img class="market-item-icon" src="/assets/markitems/idleball.png" alt="">';
        }
        const item = globalItemApiData.get(cleanName);
        const iconSource = entry?.icon || ref?.icon || item?.icon || item?.image || item?.sprite || item?.img || '';
        return iconSource
            ? `<img class="market-item-icon" src="${escapeHTML(normalizeGameItemIcon(iconSource))}" alt="">`
            : '<span class="market-item-emoji" aria-hidden="true">🌿</span>';
    }

    function getMarkerName(marker) {
        return String(
            marker?.name || marker?.title || marker?.huntName || marker?.pokemonName ||
            marker?.creatureName || marker?.pokemon?.name || marker?.creature?.name || ''
        ).trim();
    }

    function getMarkerSlug(marker) {
        return String(marker?.slug || marker?.huntSlug || marker?.hunt?.slug || '').trim();
    }

    function indexHuntMarkers(payload) {
        const content = Array.isArray(payload) ? payload : (payload?.markers || payload?.hunts || payload?.data || []);
        const markers = Array.isArray(content) ? content : (content?.markers || content?.hunts || []);

        globalHuntMarkerData.clear();
        markers.forEach(marker => {
            if (!marker || typeof marker !== 'object') return;
            const name = getMarkerName(marker);
            const slug = getMarkerSlug(marker);
            if (name) globalHuntMarkerData.set(getCleanHuntName(name), marker);
            if (slug) globalHuntMarkerData.set(slug.toLowerCase(), marker);
        });
    }

    function loadMapMarkersData(force = false) {
        if (!force && mapMarkersLoadPromise) return mapMarkersLoadPromise;
        mapMarkersLoadPromise = fetch(MAP_MARKERS_API_URL, { credentials: 'same-origin' })
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(payload => {
                indexHuntMarkers(payload);
                refreshDexEnhancements();
                return globalHuntMarkerData;
            })
            .catch(error => {
                console.warn('⚠️ Falha ao carregar os marcadores do mapa; usando o DOM como fallback.', error);
                return globalHuntMarkerData;
            });
        return mapMarkersLoadPromise;
    }

    const TYPE_CHART = {
        normal: { rock: 0.5, ghost: 0, steel: 0.5 },
        fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
        water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
        electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
        grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
        ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
        fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2 },
        poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0 },
        ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
        flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
        psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
        bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5 },
        rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
        ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
        dragon: { dragon: 2, steel: 0.5 },
        dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5 },
        steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
        fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
    };

    const BASE_POKEMON_TYPES = {
        "magneton": ["electric", "steel"], "charizard": ["fire", "flying"], "blastoise": ["water"],
        "venusaur": ["grass", "poison"], "pikachu": ["electric"], "alakazam": ["psychic"],
        "gengar": ["ghost", "poison"], "dragonite": ["dragon", "flying"], "gyarados": ["water", "flying"],
        "arcanine": ["fire"], "scyther": ["bug", "flying"], "golem": ["rock", "ground"],
        "snorlax": ["normal"], "lapras": ["water", "ice"], "machamp": ["fighting"],
        "pinsir": ["bug"], "eevee": ["normal"], "vaporeon": ["water"], "jolteon": ["electric"], "flareon": ["fire"]
    };

    let POKEMON_TYPES = { ...BASE_POKEMON_TYPES };

    async function loadExternalPokemonData() {
        try {
            const response = await fetch(POKEMON_TYPES_JSON_URL);
            if (response.ok) {
                const data = await response.json();
                const creaturesList = Array.isArray(data) ? data : (data.creatures || []);
                if (creaturesList.length > 0) {
                    const fetchedTypes = {};
                    creaturesList.forEach(poke => {
                        const pokeName = normalizePokemonName(poke.name || '');
                        const t1 = poke.type1 || poke.type_1;
                        const t2 = poke.type2 || poke.type_2;
                        if (pokeName && t1) {
                            const types = [t1.toLowerCase().trim()];
                            if (t2) types.push(t2.toLowerCase().trim());
                            fetchedTypes[pokeName] = types;
                        }
                        globalCreatureApiData.set(pokeName, poke);
                        const apiAliases = [poke.slug, poke.key, poke.apiName, poke.displayName].filter(Boolean);
                        apiAliases.forEach(alias => globalCreatureApiData.set(normalizePokemonName(alias), poke));
                    });
                    POKEMON_TYPES = { ...BASE_POKEMON_TYPES, ...fetchedTypes };
                    buildSimpleList();
                    refreshDexEnhancements();
                    loadCaughtPokedexData();
                }
            }
        } catch (e) {
            console.warn("⚠️ Falha ao carregar creatures.json", e);
        }
    }

    async function loadExternalItemData() {
        try {
            const response = await fetch(ITEMS_JSON_URL);
            if (response.ok) {
                const data = await response.json();
                const itemsList = Array.isArray(data) ? data : (data.items || Object.values(data));
                itemsList.forEach(item => {
                    if (!item) return;
                    const itemName = (item.name || item.title || '').toLowerCase().trim();
                    const itemId = String(item.id || item.key || '').toLowerCase().trim();

                    if (itemName) globalItemApiData.set(itemName, item);
                    if (itemId) globalItemApiData.set(itemId, item);
                });
                buildSimpleList();
                refreshDexEnhancements();
            }
        } catch (e) {
            console.warn("⚠️ Falha ao carregar items.json", e);
        }
    }

    loadExternalPokemonData();
    itemDataLoadPromise = loadExternalItemData();
    loadMapMarkersData();

    function applyOutlandModifier(baseMultiplier) {
        if (baseMultiplier === 1.5) return 1.75;
        if (baseMultiplier === 2.0) return 2.50;
        if (baseMultiplier >= 4.0) return 5.50;
        if (baseMultiplier === 0.5) return 0.33;
        return baseMultiplier;
    }

    function getOffensiveMultiplier(attackerTypes, defenderTypes) {
        let bestMult = null;
        attackerTypes.forEach(attType => {
            let mult = 1.0;
            defenderTypes.forEach(defType => {
                const chart = TYPE_CHART[attType];
                if (chart && chart[defType] !== undefined) {
                    mult *= chart[defType];
                }
            });
            if (bestMult === null || mult > bestMult) {
                bestMult = mult;
            }
        });
        return applyOutlandModifier(bestMult !== null ? bestMult : 1.0);
    }

    const POKEMON_NAME_ALIASES = {
        nidoranfe: 'nidoran-f', 'nidoran female': 'nidoran-f', 'nidoran♀': 'nidoran-f',
        nidoranma: 'nidoran-m', 'nidoran male': 'nidoran-m', 'nidoran♂': 'nidoran-m',
        farfetchd: "farfetch'd", 'farfetch’d': "farfetch'd"
    };
    const TYPE_COLORS = {
        normal:'#a0aec0', fire:'#f56565', water:'#4299e1', electric:'#ecc94b', grass:'#48bb78',
        ice:'#76e4f7', fighting:'#c05640', poison:'#9f7aea', ground:'#b7791f', flying:'#90cdf4',
        psychic:'#ed64a6', bug:'#9ae640', rock:'#a67c52', ghost:'#6b46c1', dragon:'#805ad5',
        dark:'#4a5568', steel:'#cbd5e0', fairy:'#fbb6ce'
    };

    function normalizePokemonName(name) {
        const normalized = String(name || '').toLowerCase().normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
        return POKEMON_NAME_ALIASES[normalized] || normalized;
    }

    function getCleanHuntName(huntName) {
        if (!huntName) return '';
        return normalizePokemonName(huntName
            .replace(/\[.*?\]/g, '')
            .replace(/\(.*\)/g, '')
            .trim());
    }

    function getDefenderTypes(huntName) {
        const cleanName = getCleanHuntName(huntName);
        if (POKEMON_TYPES[cleanName]) return POKEMON_TYPES[cleanName];

        const words = cleanName.split(/\s+/);
        for (let i = words.length - 1; i >= 0; i--) {
            const subName = words.slice(i).join(' ');
            if (POKEMON_TYPES[subName]) return POKEMON_TYPES[subName];
            if (POKEMON_TYPES[words[i]]) return POKEMON_TYPES[words[i]];
        }
        return [];
    }

    function resolveItemIcon(itemName) {
        const cleanKey = itemName.toLowerCase().trim();
        let itemObj = globalItemApiData.get(cleanKey);

        if (!itemObj) {
            for (const [key, val] of globalItemApiData.entries()) {
                if (cleanKey.includes(key) || key.includes(cleanKey)) {
                    itemObj = val;
                    break;
                }
            }
        }

        if (itemObj) {
            const imgPath = itemObj.image || itemObj.icon || itemObj.sprite || itemObj.img || '';
            if (imgPath) {
                const fullImgUrl = imgPath.startsWith('http') ? imgPath : `https://poke.idleworld.online/${imgPath.startsWith('/') ? imgPath.slice(1) : imgPath}`;
                return `<img src="${escapeHTML(fullImgUrl)}" style="width:20px; height:20px; vertical-align:middle; margin-right:8px; object-fit:contain;" />`;
            }
        }

        return `<span style="display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; background:#12202a; border:1px solid #273f52; border-radius:4px; margin-right:8px; font-size:10px; color:#48bb78;">🌿</span>`;
    }

    function parseDropsHTML(rawDrops) {
        if (!rawDrops) return '';

        if (Array.isArray(rawDrops)) {
            return rawDrops.map(d => {
                let itemName = 'Item';
                let customImgHTML = '';

                if (typeof d === 'object' && d !== null) {
                    itemName = d.name || d.item || d.label || d.title || 'Item';
                    const directImg = d.image || d.icon || d.sprite || d.img || '';
                    if (directImg) {
                        const fullUrl = directImg.startsWith('http') ? directImg : `https://poke.idleworld.online/${directImg.startsWith('/') ? directImg.slice(1) : directImg}`;
                        customImgHTML = `<img src="${escapeHTML(fullUrl)}" style="width:20px; height:20px; vertical-align:middle; margin-right:8px; object-fit:contain;" />`;
                    }
                } else {
                    itemName = String(d);
                }

                const iconHTML = customImgHTML || resolveItemIcon(itemName);
                const itemData = globalItemApiData.get(String(itemName).toLowerCase().trim()) || d || {};
                const rarity = String(itemData.rarity || itemData.tier || '').toLowerCase();
                const rawChance = Number(d?.chance ?? d?.dropChance ?? d?.dropRate ?? d?.rate ?? d?.probability ?? itemData.dropChance ?? itemData.chance);
                const chancePercent = Number.isFinite(rawChance) ? (rawChance <= 1 ? rawChance * 100 : rawChance) : null;
                const chanceRarity = chancePercent === null ? 'common' : chancePercent <= .1 ? 'legendary'
                    : chancePercent <= 1 ? 'epic' : chancePercent <= 5 ? 'rare' : chancePercent <= 20 ? 'uncommon' : 'common';
                const resolvedRarity = rarity || chanceRarity;
                const rarityColor = resolvedRarity.includes('legend') ? '#f6c453'
                    : resolvedRarity.includes('epic') ? '#d6a2ff'
                        : resolvedRarity.includes('rare') ? '#63b3ed'
                            : resolvedRarity.includes('uncommon') ? '#68d391' : '#a0aec0';

                return `
                    <div style="display:flex; align-items:center; margin-bottom:6px; font-size:13px; color:#cbd5e0; background:rgba(20,34,45,0.6); padding:4px 8px; border-radius:4px; border:1px solid #1a2d3a;">
                        ${iconHTML}
                        <span style="font-weight:800; color:${rarityColor} !important;">${escapeHTML(itemName)}</span>
                    </div>
                `;
            }).join('');
        }

        if (typeof rawDrops === 'string') {
            return `<div style="font-size:13px; color:#cbd5e0;">${escapeHTML(rawDrops)}</div>`;
        }

        return '';
    }

    function extractHuntDetailsFromJSON(name, marker) {
        const cleanName = getCleanHuntName(name);
        let priceVal = 0;
        let experience = 0;
        let dropsHTML = '';

        if (globalCreatureApiData.has(cleanName)) {
            const pokeObj = globalCreatureApiData.get(cleanName);
            const possiblePriceKeys = ['sellValue', 'priceNpc', 'sell', 'sellsFor', 'price', 'value', 'gold', 'money', 'cost', 'reward'];

            for (const key of possiblePriceKeys) {
                if (pokeObj[key] !== undefined && pokeObj[key] !== null && pokeObj[key] !== '') {
                    const parsed = parseGameNumber(pokeObj[key]);
                    if (parsed > 0) {
                        priceVal = parsed;
                        break;
                    }
                }
            }

            if (pokeObj.experience !== undefined) {
                experience = parseInt(pokeObj.experience, 10) || 0;
            } else if (pokeObj.exp !== undefined) {
                experience = parseInt(pokeObj.exp, 10) || 0;
            }

            const rawDrops = pokeObj.drops || pokeObj.drop || pokeObj.loot || pokeObj.items;
            dropsHTML = parseDropsHTML(rawDrops);
        }

        if ((priceVal === 0 || !dropsHTML) && marker) {
            marker.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            const mapTip = document.querySelector('.map-tip');
            if (mapTip) {
                if (priceVal === 0) {
                    const sellEl = mapTip.querySelector('.map-tip-sell b') || mapTip.querySelector('.map-tip-sell');
                    if (sellEl) {
                        const parsedDom = parseGameNumber(sellEl.textContent);
                        if (parsedDom > 0) priceVal = parsedDom;
                    }
                }
                if (!dropsHTML) {
                    const dropsEl = mapTip.querySelector('.map-tip-drops');
                    if (dropsEl) {
                        dropsHTML = `<div style="font-size:13px; color:#cbd5e0; padding:4px;">${dropsEl.innerHTML}</div>`;
                    }
                }
            }
            marker.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        }

        let sellsFor = priceVal > 0 ? `$ ${priceVal.toLocaleString('en-US')}` : 'Indisponível';
        if (cleanName === 'aerodactyl') sellsFor = 'Não pode ser vendido';
        const expText = experience > 0 ? `${experience.toLocaleString('en-US')} XP` : '';
        return { sellsFor, numericPrice: priceVal, dropsHTML, experience, expText };
    }

    const style = document.createElement('style');
    style.id = 'simplifier-dynamic-styles';

    style.innerHTML = `
        :root { --piw-game-font: Barlow, "Barlow Fallback", system-ui, sans-serif; }
        html.script-unified-fonts,
        html.script-unified-fonts body,
        html.script-unified-fonts body * {
            font-family: var(--piw-game-font) !important;
        }
        html.script-custom-scrollbars * {
            scrollbar-width: thin;
            scrollbar-color: rgba(200, 170, 110, .48) transparent;
        }
        html.script-custom-scrollbars *::-webkit-scrollbar { width: 7px; height: 7px; }
        html.script-custom-scrollbars *::-webkit-scrollbar-track { background: transparent; }
        html.script-custom-scrollbars *::-webkit-scrollbar-corner { background: transparent; }
        html.script-custom-scrollbars *::-webkit-scrollbar-thumb {
            background: rgba(200, 170, 110, .34);
            border: 2px solid transparent;
            background-clip: padding-box;
            border-radius: 999px;
        }
        html.script-custom-scrollbars *::-webkit-scrollbar-thumb:hover { background: rgba(230, 205, 142, .58); background-clip: padding-box; }
        .promo-overlay { display: none !important; }
#script-sidebar:not([data-location="city"]) #dock-btn-sell {
    display: none !important;
}
        #script-sidebar {
            position: fixed; left: 8px; top: 50%; transform: translateY(-50%);
            display: flex; flex-direction: column; align-items: center; gap: 6px;
            background: rgba(20, 16, 10, .85);
            border: 2px solid rgb(120, 90, 40); border-radius: 10px;
            padding: 8px 6px; z-index: 9000;
            backdrop-filter: blur(4px);
        }
        #script-sidebar[data-location="hunt"] .script-sidebar-wrap,
        #script-sidebar[data-location="hunt"] #dock-btn-depot,
        #script-sidebar:not([data-location="hunt"]) #dock-btn-city {
            display: none !important;
        }
        #dock-btn-quick-tp, #dock-btn-shops, #dock-btn-depot, #dock-btn-city {
            background: transparent;
            border: 0;
            box-shadow: none;
            display: inline-flex; align-items: center; justify-content: center;
            width: 36px; height: 36px; border-radius: 8px; cursor: pointer;
            transition: background .15s;
        }
        #dock-btn-quick-tp:hover, #dock-btn-shops:hover, #dock-btn-depot:hover, #dock-btn-city:hover {
            background: rgba(255,255,255,.12);
        }

        #dock-btn-quick-tp[hidden] { display: none !important; }
        #script-sidebar[data-location="hunt"] #dock-btn-quick-tp[hidden],
        #script-sidebar[data-location="unknown"] #dock-btn-quick-tp[hidden] { display: inline-flex !important; }
        #dock-btn-quick-tp { color: #ffcc00; font-size: 16px; font-weight: bold; }
        #dock-btn-shops { color: #9ae6b4; font-size: 15px; }
        #dock-btn-depot { color: #90cdf4; font-size: 15px; }
        #dock-btn-city { font-size: 20px; line-height: 1; }
#dock-btn-sell { color: #f6c453; font-size: 15px; }
        .script-sidebar-wrap { position: relative; display: flex; align-items: center; }
        .script-sidebar-wrap .poke-menu[hidden] { display: none !important; }
        .script-sidebar-wrap .poke-menu {
            position: absolute; left: 100%; top: 50%; transform: translateY(-50%);
            margin-left: 8px; white-space: nowrap;
        }
        @media (max-width: 720px) {
            #custom-hunts-filter-bar { grid-template-columns: 1fr !important; }
        }

        .win-window, .cfg-window, .mk-window, .ball-window, .ha-window, .inv-window, .dex-window,
        .dep-window, .prof-window, .breed-window, .poke-window, .sell-confirm-modal,
        .cap-panel, .chat-box, .npc-dialog, .script-market-window {
            border-radius: 10px !important;
        }
        nav.game-dock, .phud.game-hud-tl, .phud.game-hud.t1 {
            border-radius: 10px !important;
            border: 2px solid rgb(120, 90, 40) !important;
            border-image: none !important;
            background-clip: padding-box !important;
        }
        nav.game-dock::before, .phud.game-hud-tl::before, .phud.game-hud.t1::before {
            border-radius: 7px !important;
        }
        .cfg-window.script-mods-open {
            width: min(920px, 94vw) !important; max-width: 94vw !important;
            height: min(780px, 92vh) !important; max-height: 92vh !important;
        }
        .cfg-window.script-mods-open .cfg-body { min-height: 0; overflow: hidden !important; }
        .cfg-mods-content { width: 100%; height: 100%; min-width: 0; overflow: auto; box-sizing: border-box; }

        .cfg-mods-content .script-mods-grid {
            display: flex; flex-direction: column; gap: 12px;
            padding: 14px; background: #0c161f; border-radius: 10px;
        }
        .cfg-mods-content .script-mods-title {
            font-size: 17px; font-weight: bold; color: #63b3ed;
            border-bottom: 1px solid #1a2d3a; padding-bottom: 10px;
        }

        .script-mod-category { min-width: 0; border: 1px solid #23394a; border-radius: 10px; background: #0a141c; }
        .script-mod-category > h3 {
            margin: 0; padding: 10px 12px; display: flex; align-items: center; gap: 8px;
            color: #d9c38c; font-size: 14px; background: #101e28;
            border-bottom: 1px solid #23394a; border-radius: 9px 9px 0 0;
        }
        .script-mod-category-grid {
            display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px; padding: 10px; align-items: stretch;
        }
        .script-mod-category-grid > .cfg-row {
            box-sizing: border-box; min-width: 0; height: 100%; margin: 0;
            padding: 12px; border-radius: 8px; background: #14222d; border: 1px solid #1a2d3a;
            display: flex; flex-direction: column; gap: 8px; justify-content: flex-start;
        }
        .script-mod-category-grid > .cfg-row.script-mods-wide,
        .script-mod-category-grid > .cfg-row:only-child { grid-column: 1 / -1; }

        .script-mod-category-grid > label.cfg-row { flex-direction: row; align-items: flex-start; cursor: pointer; }
        .cfg-mods-content .cfg-row input[type="checkbox"] {
            flex: 0 0 auto; width: 18px; height: 18px; margin: 1px 0 0; cursor: pointer; accent-color: #c8a24e;
        }
        .cfg-mods-content .cfg-label { flex: 1; min-width: 0; margin: 0; }
        .cfg-mods-content .cfg-label b { color: #e2e8f0; font-size: 14px; }
        .cfg-mods-content .cfg-label span { display: block; margin-top: 4px; line-height: 1.35; color: #a0aec0; font-size: 11px; }

        .cfg-mods-sublist { display: flex; flex-direction: column; gap: 2px; }
        .cfg-mods-sublist > label { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; padding: 5px 0; }
        .cfg-mods-sublist .cfg-label b { font-size: 12px; }

        .script-mod-category-grid .cfg-seg { display: flex; gap: 4px; width: 100%; align-items: stretch; margin-top: auto; }
        .script-mod-category-grid .cfg-seg-btn { min-width: 0; white-space: normal; line-height: 1.2; }
        .script-mod-category-grid .cfg-seg > .cfg-seg-btn { flex: 1; }
        .script-mod-category-grid input:not([type="checkbox"]):not([type="radio"]),
        .script-mod-category-grid select { box-sizing: border-box; max-width: 100%; width: 100%; }
        .cfg-mods-field {
            background: #0c161f; color: #e2e8f0; border: 1px solid #273f52;
            border-radius: 6px; padding: 7px;
        }
        .cfg-font-file-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .cfg-font-file-name { min-width: 0; flex: 1; color: #91a4b2; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .cfg-sell-confirm { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
        .cfg-sell-confirm > * { flex: 1; min-width: 180px; }
        #cfg-sell-selected-list { display: flex; flex-direction: column; gap: 4px; max-height: 120px; overflow-y: auto; padding-right: 4px; }
        .cfg-sell-dd-wrap { position: relative; }
        #cfg-sell-dd-btn { width: 100%; text-align: left; background: #0c161f; color: #e2e8f0; border: 1px solid #273f52; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
        #cfg-sell-dropdown-menu {
            display: none; position: absolute; top: 100%; right: 0; width: 100%; background: #14222d;
            border: 1px solid #273f52; border-radius: 4px; z-index: 10; box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            margin-top: 4px; padding: 6px; box-sizing: border-box;
        }
        #cfg-sell-search { background: #0c161f; color: #e2e8f0; border: 1px solid #273f52; border-radius: 4px; padding: 6px; outline: none; margin-bottom: 6px; }
        #cfg-sell-dropdown { max-height: 150px; overflow-y: auto; }
        @media (max-width: 720px) {
            .script-mod-category-grid { grid-template-columns: 1fr; }
        }

        .hunt-drop-tooltip {
            position: absolute; background: #0c161f; border: 1px solid #233e52;
            border-radius: 8px; padding: 10px 14px; z-index: 9999; font-size: 13px;
            color: #e2e8f0; pointer-events: none; box-shadow: 0 8px 20px rgba(0,0,0,0.8);
            min-width: 180px; max-width: 280px;
        }
        .drop-icon-btn {
            background: #14222d; border: 1px solid #2b4c66; color: #48bb78;
            border-radius: 50%; width: 24px; height: 24px; font-size: 12px;
            display: inline-flex; align-items: center; justify-content: center;
            cursor: pointer; margin-left: 8px; font-weight: bold; transition: all 0.2s;
        }
        .drop-icon-btn:hover { background: #1c3040; border-color: #48bb78; }

        .map-window {
            display: flex !important;
            flex-direction: column !important;
            width: 820px !important;
            max-width: 95vw !important;
            height: min(680px, 92vh) !important;
            background: #0b141c !important;
            color: #fff !important;
            border: 1px solid #6f5526 !important;
            border-radius: 14px !important;
            overflow: hidden !important;
            box-shadow: 0 18px 55px rgba(0,0,0,.72) !important;
        }
        .map-window > *:first-child,
        .map-window .map-head,
        .map-window .map-header { border-radius: 13px 13px 0 0 !important; }
        .map-window .map-body {
            flex: 1 !important;
            width: 100% !important;
            height: 100% !important;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            background: #0b141c !important;
            padding: 0 12px 12px !important;
            overflow: hidden !important;
        }
        .map-window .script-hidden-native-types {
            display: none !important;
        }
        .map-window .map-area, .map-window .map-plate {
            border-radius: 9px !important;
            overflow: hidden !important;
        }
        .map-window .script-city-area {
            min-width: 80px !important;
            min-height: 46px !important;
            padding: 8px 16px !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            background: #111c25 !important;
            color: #e2e8f0 !important;
            border: 1px solid #263746 !important;
            border-radius: 10px !important;
            font: 800 12px var(--piw-game-font) !important;
            cursor: pointer !important;
        }
        .map-window .script-city-area.on {
            color: #f6c453 !important;
            border-color: #9f7b35 !important;
            background: #1b211f !important;
        }
        .map-window .map-filter-q,
        .map-window input[type="number"],
        .map-window select {
            border-radius: 8px !important;
            border-color: #263d4e !important;
            background: #0d1a24 !important;
        }
        #custom-hunts-filter-bar {
            background: #101d27 !important;
            border: 1px solid #203544 !important;
            border-radius: 11px !important;
            padding: 9px !important;
            margin: 8px 0 !important;
        }
        #custom-hunts-filter-bar select {
            min-height: 34px;
            border-radius: 8px !important;
            box-shadow: none !important;
        }
        #simple-hunts-container .script-type-badge { color:#fff !important; border:1px solid rgba(255,255,255,.22) !important; font-weight:900 !important; text-shadow:0 1px 2px rgba(0,0,0,.7) !important; }
        #simple-hunts-container .script-type-normal{background:#718096!important}.script-type-fire{background:#e53e3e!important}.script-type-water{background:#3182ce!important}
        #simple-hunts-container .script-type-electric{background:#d69e2e!important;color:#161b22!important}.script-type-grass{background:#38a169!important}.script-type-ice{background:#38b2ac!important}
        #simple-hunts-container .script-type-fighting{background:#c05621!important}.script-type-poison{background:#805ad5!important}.script-type-ground{background:#975a16!important}
        #simple-hunts-container .script-type-flying{background:#63b3ed!important}.script-type-psychic{background:#d53f8c!important}.script-type-bug{background:#68a819!important}
        #simple-hunts-container .script-type-rock{background:#8b6b3f!important}.script-type-ghost{background:#553c9a!important}.script-type-dragon{background:#6b46c1!important}
        #simple-hunts-container .script-type-dark{background:#2d3748!important}.script-type-steel{background:#a0aec0!important;color:#161b22!important}.script-type-fairy{background:#ed64a6!important}
        #simple-hunts-container .script-effectiveness { font-size:12px!important;font-weight:950!important;padding:4px 9px!important;border-radius:999px!important;border:1px solid currentColor!important; }
        #simple-hunts-container .script-effectiveness.great { color:#9cffb2!important;background:#123d25!important;box-shadow:0 0 9px rgba(72,187,120,.55)!important; }
        #simple-hunts-container .script-effectiveness.neutral { color:#cbd5e0!important;background:#293746!important; }
        #simple-hunts-container .script-effectiveness.bad { color:#ff9b9b!important;background:#481d24!important;box-shadow:0 0 8px rgba(245,101,101,.4)!important; }
        #simple-hunts-container {
            flex: 1 !important;
            max-height: none !important;
            min-height: 0 !important;
            padding: 4px 5px 4px 2px !important;
            margin-top: 0 !important;
            background: transparent !important;
            border: 0 !important;
            border-radius: 12px !important;
            scrollbar-color: #315269 transparent;
        }
        #simple-hunts-container > div {
            border-radius: 10px !important;
            margin-bottom: 7px !important;
            box-shadow: inset 0 0 0 1px rgba(85,125,151,.12);
            transition: background .15s ease, transform .15s ease, opacity .15s ease;
        }
        #simple-hunts-container > div:hover {
            background-color: #172a37 !important;
            transform: translateX(2px);
        }
        #simple-hunts-container > div > div:first-child {
            border-radius: 50% !important;
        }
        #simple-hunts-container [style*="text-transform: uppercase"] {
            background: transparent !important;
            border: 1px solid #304657;
            color: #8fa6b8 !important;
            padding: 1px 4px !important;
            opacity: .85;
        }

        .mod-disabled {
            opacity: 0.35 !important;
            pointer-events: none !important;
            filter: grayscale(100%);
        }

        .mk-lock-sell { font-size: 14px; background: none; border: none; cursor: pointer; margin-left: 6px; padding: 2px; }
        .mk-lock-sell:hover { opacity: 0.8; }
        .mk-srow-head.locked { opacity: 0.6; }
        .mk-bulk-controls { display: inline-flex; gap: 4px; margin-left: 6px; vertical-align: middle; }
        .mk-bulk-btn { background: #14222d; color: #63b3ed; border: 1px solid #273f52; border-radius: 4px; padding: 3px 7px; font-size: 11px; font-weight: bold; cursor: pointer; }
        .mk-bulk-btn:hover { background: #1a365d; border-color: #3182ce; color: #fff; }
        .hunt-sell-list { max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
        .hunt-sell-row { display: grid; grid-template-columns: auto 1fr 80px; align-items: center; gap: 8px; background: #14222d; border: 1px solid #1a2d3a; border-radius: 5px; padding: 7px 9px; }
        .hunt-sell-row[hidden] { display: none !important; }
        .hunt-sell-row input[type="number"] { width: 100%; box-sizing: border-box; background: #0c161f; color: #e2e8f0; border: 1px solid #273f52; border-radius: 4px; padding: 5px; }
        .hunt-sell-row.protected { opacity: 0.45; }
        .hunt-pokemon-sell-icon { width: 28px; height: 28px; object-fit: contain; image-rendering: pixelated; }
        .hunt-item-sell-icon { width: 28px; height: 28px; object-fit: contain; flex: none; }

        .sell-confirm-backdrop { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.5); z-index: 10150; display: flex; align-items: center; justify-content: center; }
        .sell-confirm-modal { background: #0c161f; border: 1px solid #273f52; border-radius: 8px; padding: 0; color: #e2e8f0; width: 320px; box-shadow: 0 12px 32px rgba(0,0,0,0.8); overflow: hidden; }
        .sell-confirm-title { background: #14222d; border-bottom: 1px solid #273f52; padding: 12px 16px; font-size: 15px; font-weight: bold; color: #63b3ed; display: flex; align-items: center; gap: 8px; }
        .sell-confirm-body { padding: 16px; }
        .sell-confirm-body p { color: #a0aec0; font-size: 13px; margin: 0 0 10px 0; }
        .sell-confirm-items { background: #14222d; border: 1px solid #1a2d3a; border-radius: 6px; padding: 8px 12px; margin-bottom: 16px; max-height: 100px; overflow-y: auto; }
        .sell-confirm-items div { color: #ffcc00; font-weight: bold; font-size: 13px; padding: 2px 0; }
        .sell-confirm-footer { display: flex; gap: 8px; }
        .sell-confirm-btn { flex: 1; padding: 8px; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 13px; transition: background 0.15s; }
        .sell-confirm-btn.yes { background: #48bb78; color: #fff; }
        .sell-confirm-btn.yes:hover { background: #38a169; }
        .sell-confirm-btn.no { background: #2b4c66; color: #e2e8f0; border: 1px solid #273f52; }
        .sell-confirm-btn.no:hover { background: #3182ce; }

        .sell-confirm-backdrop, .script-market-backdrop, .portable-ball-backdrop {
            background: rgba(0, 0, 0, .62) !important;
            backdrop-filter: blur(1px);
        }
        .sell-confirm-modal, .script-market-window, .script-portable-ball-window, .ha-compare-modal {
            background: linear-gradient(rgba(16, 24, 35, .99), rgba(9, 14, 21, .99)) !important;
            color: rgb(233, 226, 208) !important;
            border: 2px solid rgb(120, 90, 40) !important;
            border-radius: 10px !important;
            box-shadow: 0 12px 40px rgba(0, 0, 0, .7) !important;
            font-family: var(--piw-game-font) !important;
        }
        .sell-confirm-title,
        .script-market-window .cfg-title,
        .script-portable-ball-window .ball-head,
        .ha-compare-modal .ha-title {
            min-height: 47px;
            box-sizing: border-box;
            padding: 12px 14px 8px !important;
            background: transparent !important;
            border-bottom: 1px solid rgba(200, 170, 110, .16) !important;
            color: rgb(240, 230, 210) !important;
            font-family: var(--piw-game-font) !important;
            font-size: 17px !important;
            font-weight: 700 !important;
        }
        .sell-confirm-body { background: transparent !important; color: rgb(233, 226, 208) !important; }
        .sell-confirm-body p { color: rgb(174, 181, 188) !important; }
        .sell-confirm-modal input, .sell-confirm-modal select,
        .script-market-window input, .script-market-window select,
        .script-portable-ball-window input, .script-portable-ball-window select,
        .ha-compare-modal input, .ha-compare-modal select {
            box-sizing: border-box;
            min-height: 28px;
            background: rgba(8, 15, 22, .8) !important;
            color: rgb(230, 237, 243) !important;
            border: 1px solid rgb(58, 74, 92) !important;
            border-radius: 6px !important;
            padding: 5px 8px !important;
            font: 400 12px var(--piw-game-font) !important;
            outline: none;
        }
        .sell-confirm-modal input:focus, .sell-confirm-modal select:focus,
        .script-market-window input:focus, .script-market-window select:focus,
        .script-portable-ball-window input:focus, .script-portable-ball-window select:focus {
            border-color: rgb(200, 162, 78) !important;
            box-shadow: 0 0 0 2px rgba(200, 162, 78, .15) !important;
        }
        .sell-confirm-btn.yes, .portable-depot-clear-filters,
        .script-market-window .market-refresh, .script-portable-ball-window .mk-buy-btn {
            background: linear-gradient(rgb(230, 205, 142), rgb(200, 162, 78)) !important;
            color: rgb(26, 18, 6) !important;
            border: 1px solid rgb(106, 82, 35) !important;
            border-radius: 8px !important;
            font-weight: 800 !important;
        }
        .sell-confirm-btn.yes:hover, .portable-depot-clear-filters:hover,
        .script-market-window .market-refresh:hover, .script-portable-ball-window .mk-buy-btn:hover {
            filter: brightness(1.08);
        }
        .script-market-window .market-tab.on { background: linear-gradient(#d8b86b,#9c762f) !important; color:#171006 !important; }
        .market-sell-controls input, .market-sell-controls select { background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px 8px;min-width:88px; }
        .market-sell-controls .market-sell-search { flex:1;min-width:180px; }
        .market-sell-controls .market-sell-qty { width:76px; }
        .market-sell-controls .market-sell-price { width:140px; }
        .market-sell-row { width:100%;display:grid;grid-template-columns:42px 1fr;gap:10px;align-items:center;text-align:left;background:#14222d;color:#e2e8f0;border:1px solid #1f3545;border-radius:7px;padding:8px 10px; }
        .market-sell-row:hover,.market-sell-row.on { border-color:#c8a24e;background:#1b2c39; }
        .market-sell-row img { width:38px;height:38px;object-fit:contain; }
        .market-list .market-pokemon-icon { width:38px;height:38px;object-fit:contain;image-rendering:pixelated;flex:none; }
        .market-list .market-item-icon { width:38px;height:38px;object-fit:contain;flex:none; }
        .market-list .market-item-emoji { width:38px;height:38px;display:inline-flex;align-items:center;justify-content:center;flex:none;font-size:24px; }
        .market-sell-row small { display:block;color:#9fb0bd;margin-top:3px; }
        .mk-row .script-mark-product-icon { width:34px;height:34px;object-fit:contain;flex:none; }
        .script-quality-multiselect { position:relative;display:inline-block;z-index:8; }
        .script-quality-toggle { min-width:170px;text-align:left; }
        .script-quality-dropdown { position:absolute;min-width:190px;padding:7px;background:#101b24;border:1px solid #7a5a27;border-radius:6px;box-shadow:0 8px 22px #000b;display:grid;gap:3px;z-index:100000;pointer-events:auto; }
        .script-quality-option { display:flex;gap:7px;align-items:center;width:100%;padding:4px 5px;border-radius:4px;background:transparent;color:#e8dfcc;cursor:pointer;box-sizing:border-box;user-select:none;pointer-events:auto; }
        .script-quality-option:hover { background:#ffffff12; }
        .script-quality-option input { flex:0 0 auto;margin:0;accent-color:#3182ce;pointer-events:auto; }
        .script-mark-row-buy { display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;margin-left:auto; }
        .script-mark-row-buy .mk-bulk-btn { min-width:38px;padding:5px 7px;font-size:11px; }
        .sell-confirm-btn.no, .mk-bulk-btn, .dex-fbtn {
            background: rgba(255, 255, 255, .035) !important;
            color: rgb(233, 226, 208) !important;
            border: 1px solid rgba(200, 170, 110, .24) !important;
            border-radius: 8px !important;
        }
        .mk-bulk-btn.active, .mk-bulk-btn:hover, .dex-fbtn.on, .dex-fbtn:hover {
            background: rgba(200, 170, 110, .16) !important;
            color: rgb(240, 230, 210) !important;
            border-color: rgba(230, 205, 142, .45) !important;
        }
        .portable-depot-family-tabs { display: inline-flex; gap: 6px; }
        .portable-depot-backdrop .sell-confirm-title { gap: 6px; }
        .portable-depot-backdrop .depot-tab {
            min-height: 34px;
            padding: 7px 8px !important;
            border-radius: 8px 8px 0 0 !important;
            font: 700 12.5px Barlow, "Barlow Fallback", sans-serif !important;
        }
        .portable-depot-backdrop .depot-tab.active {
            background: rgba(200, 170, 110, .16) !important;
            color: rgb(240, 230, 210) !important;
        }
        .portable-depot-content section,
        .hunt-sell-row, .market-row, .market-listing, .primary-favorite-list > * {
            background: transparent !important;
            border-color: rgba(255, 255, 255, .05) !important;
            border-radius: 8px !important;
        }
        .portable-depot-content section button,
        .hunt-sell-row, .market-row, .market-listing {
            background: rgba(255, 255, 255, .02) !important;
            color: rgb(233, 226, 208) !important;
            border: 1px solid rgba(255, 255, 255, .05) !important;
            border-radius: 8px !important;
        }
        .portable-depot-content section button:hover,
        .hunt-sell-row:hover, .market-row:hover, .market-listing:hover {
            background: rgba(200, 170, 110, .08) !important;
            border-color: rgba(200, 170, 110, .24) !important;
        }
        .portable-depot-poke-filters {
            flex-basis: 100%;
            display: grid;
            grid-template-columns: minmax(190px, 2fr) repeat(4, minmax(82px, 1fr)) auto;
            gap: 6px;
            padding: 9px;
            background: rgba(255, 255, 255, .02);
            border: 1px solid rgba(255, 255, 255, .05);
            border-radius: 8px;
        }
        .portable-depot-item-filters {
            flex-basis: 100%;
            display: grid;
            grid-template-columns: minmax(220px, 1fr) auto;
            gap: 6px;
            padding: 9px;
            background: rgba(255, 255, 255, .02);
            border: 1px solid rgba(255, 255, 255, .05);
            border-radius: 8px;
        }
        .portable-depot-item-filters input { min-width: 0; }
        .portable-depot-clear-filters { min-height: 28px; padding: 5px 10px; cursor: pointer; }
        .portable-shop-heading {
            margin: 8px 0 0;
            padding: 7px 3px 5px;
            color: rgb(240, 230, 210);
            border-bottom: 1px solid rgba(200, 170, 110, .2);
            font: 700 14px Cinzel, "Cinzel Fallback", serif;
        }
        @media (max-width: 760px) {
            .portable-depot-poke-filters { grid-template-columns: 1fr 1fr; }
            .portable-depot-poke-filters input:first-child { grid-column: 1 / -1; }
            .portable-depot-item-filters { grid-template-columns: minmax(0, 1fr) auto; }
        }

        .dex-script-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 10px; border-top: 1px solid #1a2d3a; }
        .dex-fbtn { padding: 4px 10px; border: 1px solid #273f52; background: #0c161f; color: #a0aec0; border-radius: 4px; cursor: pointer; font-size: 12px; transition: all 0.15s; }
        .dex-fbtn:hover { border-color: #3182ce; color: #e2e8f0; }
        .dex-fbtn.on { background: #3182ce; color: #fff; border-color: #3182ce; }

        .hunt-capture-badge {
            display: inline-block; width: 13px; height: 13px; min-width: 13px; border-radius: 50%;
            border: 1px solid #1a1a1a; position: relative; flex-shrink: 0;
            background: linear-gradient(to bottom, #e53e3e 0%, #e53e3e 46%, #1a1a1a 46%, #1a1a1a 54%, #f7fafc 54%, #f7fafc 100%);
        }
        .hunt-capture-badge::after {
            content: ''; position: absolute; top: 50%; left: 50%; width: 4px; height: 4px;
            background: #f7fafc; border: 1px solid #1a1a1a; border-radius: 50%; transform: translate(-50%, -50%);
        }
        .hunt-capture-badge.not-caught { filter: grayscale(1) brightness(0.65); opacity: 0.5; }
        .dex-ft-label { display: flex; align-items: center; gap: 4px; color: #a0aec0; font-size: 12px; cursor: pointer; margin-left: auto; }
        .dex-ft-label input { cursor: pointer; }
        .dex-cell.dex-hidden { display: none !important; }

        .ha-window.ha-compact {
            width: 320px; min-width: 300px; max-width: 90vw;
            min-height: 360px; max-height: 90vh;
            box-sizing: border-box !important; resize: both !important;
            overflow: auto !important; border-radius: 12px !important;
        }
        .ha-window:not(.ha-compare-modal) { opacity: 1 !important; }
        .ha-window.ha-compact .ha-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 4px !important; }
        .ha-window.ha-compact .ha-card { padding: 4px 8px !important; flex-direction: row !important; align-items: center !important; justify-content: flex-start !important; gap: 8px !important; }
        .ha-window.ha-compact .ha-card small { display: none !important; }
        .ha-window.ha-compact .ha-card-ico { font-size: 16px !important; margin: 0 !important; }
        .ha-window.ha-compact .ha-card b { font-size: 14px !important; }
        .ha-window.ha-compact .ha-balance { font-size: 14px !important; padding: 4px !important; flex-direction: row !important; justify-content: space-between !important; }
        .ha-window.ha-compact .ha-balance span { display: none !important; }
        .ha-window.ha-compact .ha-balance::before { content: 'Balance'; font-weight: bold; }
        .ha-window.ha-compact .ha-rates { display: flex !important; flex-direction: column !important; align-items: stretch !important; gap: 4px !important; padding: 4px !important; font-size: 11px !important; }
        .ha-window.ha-compact .ha-rates span { width: 100% !important; text-align: center !important; margin: 0 !important; }
        .ha-window.ha-compact .ha-drops-head, .ha-window.ha-compact .ha-note { display: none !important; }
        .ha-window.ha-compact .ha-clog-btn { display: none !important; }
        .ha-window.ha-compact .ha-drops { display: none !important; }
        .ha-window.ha-compact .ha-drops.show-drops {
            display: flex !important; max-height: none !important; min-height: 80px !important;
            overflow-y: auto !important; padding: 6px !important; flex: 1 1 auto !important;
            border-radius: 8px !important;
        }

        .ha-script-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin: 0; padding: 8px; border-bottom: 1px solid #1b3040; }
        .ha-sbtn { background: #1a2d3a; color: #a0aec0; border: 1px solid #273f52; border-radius: 6px; padding: 6px 4px; font-size: 11px; cursor: pointer; transition: all 0.15s ease; text-align: center; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 4px; }
        .ha-sbtn:hover { background: #3182ce; color: #fff; border-color: #3182ce; }
        .ha-catch-stats { display: block; width: 100%; text-align: center; margin-top: 4px; }
        .ha-catch-stats.hidden { display: none !important; }
        .ha-rates { flex-wrap: wrap !important; }

        .ha-compare-backdrop { position: fixed; inset: 0; z-index: 10100; pointer-events: none; }
        .ha-compare-modal {
            pointer-events: auto; position: fixed !important; left: 50%; top: 50%;
            transform: translate(-50%, -50%); width: min(580px, 92vw);
            min-width: 360px; min-height: 420px; max-width: 94vw; max-height: 90vh;
            overflow: auto !important; resize: both; border-radius: 14px !important;
            border: 1px solid #315269 !important; background: #0b151e !important;
            box-shadow: 0 20px 55px rgba(0,0,0,.82) !important; padding-bottom: 12px;
        }
        .ha-compare-modal .ha-title { position: sticky; top: 0; z-index: 2; background: #12222e; padding: 11px 13px; }
        .ha-compare-modal .ha-title { display: flex !important; align-items: center; gap: 8px; }
        .ha-compare-modal .ha-title > span { flex: 1 1 auto; min-width: 0; }
        .ha-compare-modal .ha-x {
            position: static !important; inset: auto !important; flex: 0 0 auto;
            width: 30px !important; height: 30px !important; margin: 0 !important;
        }
        .ha-compare-table { width: 100%; min-width: 500px; border-collapse: separate; border-spacing: 0 5px; font-size: 13px; }
        .ha-compare-table th { text-align: center; padding: 8px; color: #91a7b8; font-weight: 600; }
        .ha-compare-table td { padding: 9px; background:#101f2a; text-align: center; font-weight: bold; }
        .ha-compare-table td:first-child { border-radius: 7px 0 0 7px; }
        .ha-compare-table td:last-child { border-radius: 0 7px 7px 0; }
        .ha-compare-table tr:nth-child(even) { background-color: transparent; }
        .ha-compare-table td:first-child { text-align: left; font-weight: normal; color: #a0aec0; }
        .ha-compare-winner { color: #48bb78 !important; }
        .ha-compare-loser { color: #f56565 !important; }
        .ha-compare-modal .ha-title { cursor: grab; user-select: none; }
        .ha-compare-modal .ha-title:active { cursor: grabbing; }
        .ha-compare-backdrop {
            pointer-events: none !important;
            display: block !important;
            padding: 0 !important;
            background: transparent !important;
            backdrop-filter: none !important;
        }
        .ha-compare-modal {
            position: fixed !important;
            left: 50% !important; top: 50% !important; right: auto !important; bottom: auto !important;
            width: min(760px, 94vw);
            max-width: 94vw !important;
            max-height: 88vh !important;
            resize: both !important;
            overflow: auto !important;
            transform: translate(-50%, -50%);
        }
        .ha-compare-modal .ha-title { position: sticky !important; padding-right: 52px !important; }
        .ha-compare-modal .ha-x { position:absolute !important;right:10px !important;top:8px !important;left:auto !important;bottom:auto !important;z-index:4; }
        .ha-compare-modal > div:nth-child(2) { padding: 14px !important; }
        .ha-compare-table { width:100% !important; min-width: 440px !important; border-spacing: 0 7px !important; }
        .ha-compare-table th { background: transparent !important; color: #c7b98f !important; font-size: 12px; }
        .ha-compare-table td { background: rgba(255,255,255,.025) !important; border-top: 1px solid rgba(255,255,255,.04); border-bottom: 1px solid rgba(255,255,255,.04); }
        .ha-history-list > div { background: rgba(255,255,255,.025) !important; border: 1px solid rgba(255,255,255,.05); border-radius: 8px !important; }
        @media (max-width: 640px) {
            .ha-compare-modal > div:nth-child(2) { overflow-x: auto; }
            .ha-compare-table { min-width: 520px !important; }
        }

        .script-inventory-backdrop {
            background: transparent !important; backdrop-filter: none !important;
            pointer-events: none !important;
        }
        .script-inventory-backdrop .inv-window, .inv-window.script-resizable-inventory {
            pointer-events: auto !important; resize: both !important; overflow: auto !important;
            min-width: 260px !important; min-height: 250px !important;
            max-width: 98vw !important; max-height: 95vh !important;
            border-radius: 12px !important;
        }
        .inv-window.script-resizable-inventory .inv-grid,
        .inv-window.script-resizable-inventory .inv-items,
        .inv-window.script-resizable-inventory .inv-slots {
            width: auto !important; max-width: 100% !important; min-width: 0 !important;
            box-sizing: border-box !important;
            display: grid !important;
            grid-template-columns: repeat(auto-fill, 42px) !important;
            grid-auto-rows: 42px !important;
            justify-content: start !important; align-content: start !important;
            gap: 6px !important; padding: 8px 12px !important;
            overflow: auto !important;
        }
        .inv-window.script-resizable-inventory .inv-slot {
            width: 42px !important; height: 42px !important;
            min-width: 42px !important; max-width: 42px !important;
            min-height: 42px !important; max-height: 42px !important;
            aspect-ratio: auto !important; justify-self: start !important;
        }
        .script-capture-log-window { border-radius: 14px !important; overflow: hidden !important; }
        .script-capture-log-window .script-quality-badge {
            display: inline-block !important; margin: 0 !important; padding: 0 !important;
            white-space: nowrap !important; border: 0 !important; border-radius: 0 !important;
            background: transparent !important; font-size: inherit !important; font-weight: 800 !important;
        }
        .script-quest-tp-btn {
            margin-left: 8px;
            flex: none;
            align-self: center;
            white-space: nowrap;
            padding: 5px 9px !important;
            font-size: 11px !important;
            cursor: pointer;
        }
        .phud-party > button.phud-mon .script-party-quality {
            display: inline-block !important;
            margin-left: 5px !important;
            font-size: 10px !important;
            font-weight: 800 !important;
            line-height: 1 !important;
            vertical-align: middle !important;
            white-space: nowrap !important;
        }
/* ===== PIW Shop Unified ===== */
.piw-shop-backdrop {
    position: fixed; inset: 0; z-index: 10060;
    display: flex; align-items: center; justify-content: center;
    padding: 16px;
    background: radial-gradient(ellipse at center, rgba(8,14,22,.85), rgba(0,0,0,.92));
    backdrop-filter: blur(3px);
    font-family: var(--piw-game-font);
    animation: piwFadeIn .15s ease;
}
@keyframes piwFadeIn { from { opacity: 0; } to { opacity: 1; } }

.piw-shop-window {
    width: min(880px, 96vw);
    max-height: 90vh;
    display: flex; flex-direction: column;
    background: linear-gradient(180deg, #0f1a24 0%, #0a1219 100%);
    border: 1px solid rgba(200,170,110,.35);
    border-radius: 14px;
    box-shadow: 0 24px 70px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,255,255,.04);
    overflow: hidden;
    color: #e8e2d0;
}

.piw-shop-header {
    display: flex; align-items: center; gap: 14px;
    padding: 14px 18px;
    background: linear-gradient(180deg, rgba(200,170,110,.10), transparent);
    border-bottom: 1px solid rgba(200,170,110,.18);
}
.piw-shop-title { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
.piw-shop-icon {
    width: 42px; height: 42px; flex: none;
    display: grid; place-items: center;
    font-size: 22px;
    background: rgba(200,170,110,.10);
    border: 1px solid rgba(200,170,110,.25);
    border-radius: 10px;
}
.piw-shop-title h2 { margin: 0; font-size: 16px; font-weight: 700; color: #f4ead0; }
.piw-shop-title small { display: block; margin-top: 2px; font-size: 11px; color: #8fa0b0; }

.piw-shop-balance {
    display: flex; flex-direction: column; align-items: flex-end;
    padding: 6px 12px;
    background: rgba(200,170,110,.08);
    border: 1px solid rgba(200,170,110,.20);
    border-radius: 9px;
}
.piw-balance-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8fa0b0; }
.piw-balance-value { font-size: 15px; color: #f0cd7d; font-weight: 800; }

.piw-shop-close {
    width: 34px; height: 34px; flex: none;
    background: rgba(255,255,255,.04);
    border: 1px solid rgba(255,255,255,.10);
    border-radius: 8px;
    color: #cbd5e0; font-size: 20px; line-height: 1;
    cursor: pointer; transition: all .15s;
}
.piw-shop-close:hover { background: rgba(245,101,101,.15); color: #fff; border-color: rgba(245,101,101,.4); }

/* Tabs */
.piw-shop-tabs {
    display: flex; gap: 4px; padding: 10px 18px 0;
    border-bottom: 1px solid rgba(200,170,110,.12);
}
.piw-shop-tab {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 10px 16px;
    background: transparent; color: #8fa0b0;
    border: 1px solid transparent;
    border-bottom: 2px solid transparent;
    border-radius: 8px 8px 0 0;
    font-size: 13px; font-weight: 700; cursor: pointer;
    transition: all .15s;
}
.piw-shop-tab:hover { color: #d6c8a3; background: rgba(200,170,110,.06); }
.piw-shop-tab.on {
    color: #f0cd7d;
    background: rgba(200,170,110,.08);
    border-bottom-color: #c8a24e;
}

.piw-shop-body { flex: 1; min-height: 0; overflow: auto; padding: 0; }
.piw-tab-panel { padding: 16px 18px; }
.piw-tab-panel[hidden] { display: none !important; }

.piw-shop-loading, .piw-shop-empty {
    text-align: center; padding: 40px 20px;
    color: #7a8a99; font-size: 13px;
}

/* Grupos (Poké Bolas, Poções) */
.piw-shop-group { margin-bottom: 20px; }
.piw-shop-group:last-child { margin-bottom: 0; }
.piw-shop-group-title {
    margin: 0 0 10px;
    padding: 6px 0 8px;
    font-size: 13px; font-weight: 700;
    color: #d9c38c;
    letter-spacing: .3px;
    border-bottom: 1px solid rgba(200,170,110,.20);
}

.piw-shop-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 10px;
}

/* Cards de compra */
.piw-shop-card {
    display: grid;
    grid-template-columns: 52px 1fr;
    grid-template-rows: auto auto;
    gap: 10px 12px;
    padding: 12px;
    background: rgba(255,255,255,.025);
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 10px;
    transition: border-color .15s, background .15s;
}
.piw-shop-card:hover {
    background: rgba(200,170,110,.05);
    border-color: rgba(200,170,110,.25);
}
.piw-card-icon {
    grid-row: 1 / 3;
    width: 52px; height: 52px;
    display: grid; place-items: center;
    background: rgba(0,0,0,.25);
    border-radius: 9px;
}
.piw-card-icon img { width: 42px; height: 42px; object-fit: contain; image-rendering: pixelated; }
.piw-card-info h3 { margin: 0 0 4px; font-size: 14px; color: #f0ead8; font-weight: 700; }
.piw-card-meta { display: flex; gap: 8px; flex-wrap: wrap; font-size: 11px; color: #8fa0b0; }
.piw-card-owned { color: #63b3ed; }
.piw-card-rate { color: #f6c453; }
.piw-card-price { margin-top: 5px; font-size: 13px; font-weight: 800; color: #f0cd7d; }
.piw-card-actions {
    grid-column: 1 / -1;
    display: flex; gap: 5px; flex-wrap: wrap;
    padding-top: 8px;
    border-top: 1px solid rgba(255,255,255,.05);
}
.piw-buy-btn {
    flex: 1; min-width: 52px;
    padding: 7px 6px;
    background: rgba(200,170,110,.08);
    color: #e8e2d0;
    border: 1px solid rgba(200,170,110,.22);
    border-radius: 6px;
    font-size: 11px; font-weight: 700;
    cursor: pointer; transition: all .12s;
}
.piw-buy-btn:hover:not(:disabled) {
    background: linear-gradient(180deg, #e6cd8e, #c8a24e);
    color: #1a1206;
    border-color: #6a5223;
    transform: translateY(-1px);
}
.piw-buy-btn:disabled { opacity: .45; cursor: wait; }

/* Filter bar (venda) */
.piw-filter-bar {
    display: flex; flex-wrap: wrap; gap: 10px;
    padding: 12px 18px;
    background: rgba(0,0,0,.18);
    border-bottom: 1px solid rgba(200,170,110,.12);
    align-items: center;
}
.piw-filter-search {
    display: flex; align-items: center; gap: 6px;
    flex: 1; min-width: 180px;
    padding: 6px 10px;
    background: rgba(0,0,0,.35);
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 7px;
}
.piw-filter-search input {
    flex: 1; min-width: 0;
    background: transparent; border: 0; outline: 0;
    color: #e8e2d0; font: inherit; font-size: 13px;
}
.piw-filter-iv {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: #8fa0b0;
}
.piw-filter-iv input {
    width: 62px;
    padding: 6px 8px;
    background: rgba(0,0,0,.35);
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 6px;
    color: #e8e2d0; font: inherit; font-size: 12px;
    outline: 0;
}
.piw-filter-iv input:focus { border-color: rgba(200,170,110,.45); }
.piw-filter-quality { display: flex; flex-wrap: wrap; gap: 4px; }
.piw-quality-btn {
    padding: 5px 9px;
    background: transparent;
    color: #6b7a88;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 5px;
    font-size: 10.5px; font-weight: 700;
    cursor: pointer; transition: all .12s;
    opacity: .55;
}
.piw-quality-btn.on { opacity: 1; color: #e8e2d0; border-color: rgba(200,170,110,.35); background: rgba(200,170,110,.10); }
.piw-filter-actions { display: flex; gap: 6px; margin-left: auto; }
.piw-filter-actions button {
    padding: 6px 11px;
    background: transparent; color: #cbd5e0;
    border: 1px solid rgba(255,255,255,.10);
    border-radius: 6px; font-size: 11px; font-weight: 700;
    cursor: pointer; transition: all .12s;
}
.piw-filter-actions button:hover { border-color: rgba(200,170,110,.4); color: #f0cd7d; background: rgba(200,170,110,.07); }

/* Lista de venda */
.piw-sell-list,
.piw-sell-items-list { display: flex; flex-direction: column; gap: 6px; }

.piw-sell-row {
    display: grid;
    grid-template-columns: 22px 44px 1fr auto 36px;
    align-items: center;
    gap: 12px;
    padding: 9px 12px;
    background: rgba(255,255,255,.025);
    border: 1px solid rgba(255,255,255,.05);
    border-radius: 9px;
    cursor: pointer;
    transition: all .12s;
}
.piw-sell-row:hover { background: rgba(200,170,110,.05); border-color: rgba(200,170,110,.20); }
.piw-sell-row.is-locked { opacity: .55; }
.piw-sell-row[hidden] { display: none !important; }

.piw-sell-row--item {
    grid-template-columns: 22px 44px 1fr 90px 36px;
}

.piw-sell-check {
    width: 18px; height: 18px;
    accent-color: #c8a24e; cursor: pointer;
    margin: 0;
}
.piw-sell-check:disabled { cursor: not-allowed; }

.piw-sell-icon {
    width: 44px; height: 44px;
    display: grid; place-items: center;
    background: rgba(0,0,0,.30);
    border-radius: 8px;
}
.piw-sell-icon img { width: 36px; height: 36px; object-fit: contain; image-rendering: pixelated; }

.piw-sell-info { min-width: 0; }
.piw-sell-name {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    font-size: 13px; font-weight: 700; color: #f0ead8;
}
.piw-tag {
    font-size: 9.5px; font-weight: 800;
    padding: 2px 5px; border-radius: 4px;
    text-transform: uppercase; letter-spacing: .3px;
}
.piw-tag--shiny { background: linear-gradient(90deg,#f6c453,#f0a020); color: #2a1a00; }
.piw-tag--locked { background: rgba(245,101,101,.15); color: #feb2b2; border: 1px solid rgba(245,101,101,.3); }
.piw-sell-meta {
    display: flex; gap: 10px; flex-wrap: wrap;
    margin-top: 3px;
    font-size: 11px; color: #8fa0b0;
}
.piw-sell-meta .piw-quality-label { font-weight: 800; }
.piw-sell-potential { color: #63b3ed; font-weight: 700; }
.piw-sell-price { font-size: 13px; font-weight: 800; color: #f0cd7d; white-space: nowrap; }

.piw-sell-qty {
    width: 90px; box-sizing: border-box;
    padding: 6px 8px;
    background: rgba(0,0,0,.35);
    color: #e8e2d0;
    border: 1px solid rgba(255,255,255,.10);
    border-radius: 6px;
    font: inherit; font-size: 12px;
    text-align: center;
}
.piw-sell-qty:disabled { opacity: .45; }

.piw-sell-lock {
    width: 32px; height: 32px;
    display: grid; place-items: center;
    background: rgba(255,255,255,.04);
    border: 1px solid rgba(255,255,255,.10);
    border-radius: 7px;
    font-size: 15px; cursor: pointer;
    transition: all .12s;
}
.piw-sell-lock:hover { background: rgba(200,170,110,.12); border-color: rgba(200,170,110,.35); }
.piw-sell-lock.is-locked { background: rgba(245,101,101,.12); border-color: rgba(245,101,101,.35); }

/* Footer */
.piw-shop-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 18px;
    border-top: 1px solid rgba(200,170,110,.15);
    background: rgba(0,0,0,.20);
    font-size: 12px; color: #cbd5e0;
}
.piw-sell-summary { font-weight: 600; }
.piw-sell-actions { display: flex; gap: 8px; }

.piw-btn {
    padding: 9px 18px;
    border-radius: 8px;
    font-size: 12px; font-weight: 800;
    cursor: pointer; transition: all .12s;
    border: 1px solid transparent;
}
.piw-btn--ghost { background: transparent; color: #cbd5e0; border-color: rgba(255,255,255,.12); }
.piw-btn--ghost:hover { background: rgba(255,255,255,.05); }
.piw-btn--gold {
    background: linear-gradient(180deg, #e6cd8e, #c8a24e);
    color: #1a1206; border-color: #6a5223;
}
.piw-btn--gold:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
.piw-btn--gold:disabled { opacity: .45; cursor: not-allowed; }

/* Sidebar: botão de venda */
#dock-btn-sell { color: #f6c453; font-size: 15px; }

@media (max-width: 640px) {
    .piw-filter-bar { flex-direction: column; align-items: stretch; }
    .piw-filter-actions { margin-left: 0; }
    .piw-sell-row { grid-template-columns: 22px 40px 1fr 36px; }
    .piw-sell-row--item { grid-template-columns: 22px 40px 1fr 70px 36px; }
    .piw-sell-price { grid-column: 3 / 4; grid-row: 2; font-size: 11px; }
}
/* Botão "Marcar todos" no footer */
.piw-mark-all {
    border-color: rgba(200,170,110,.30) !important;
    color: #e8e2d0 !important;
}
.piw-mark-all:hover {
    background: rgba(200,170,110,.12) !important;
    border-color: rgba(200,170,110,.50) !important;
    color: #f0cd7d !important;
}
    `;
    function appendStyleWhenReady(styleElement) {
        if (document.head) document.head.appendChild(styleElement);
        else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(styleElement), { once: true });
    }
    appendStyleWhenReady(style);
    applyGameFont();
    applyVisualPreferences();
    loadStoredCustomFont();

    const styleMapMod = document.createElement('style');
    styleMapMod.id = 'simplifier-map-override';
    styleMapMod.innerHTML = `
        .map-viewport, .map-img, .map-zoom { display: none !important; }
        .map-body { width: 100% !important; max-width: 100% !important; padding: 0 !important; background: transparent !important; }
        .hunt-marker { opacity: 0 !important; position: absolute !important; pointer-events: none !important; }
    `;

    function isScriptMapActive() { return localStorage.getItem(STORAGE_SCRIPT_ACTIVE) !== 'false'; }
    function setScriptMapActive(state) { localStorage.setItem(STORAGE_SCRIPT_ACTIVE, state ? 'true' : 'false'); applyMapScriptState(); }

    function isChatActive() { return localStorage.getItem(STORAGE_CHAT_ACTIVE) === 'true'; }
    function setChatActive(state) { localStorage.setItem(STORAGE_CHAT_ACTIVE, state ? 'true' : 'false'); applyChatState(); }

    function getNavTpMode() {
        const mode = localStorage.getItem(STORAGE_NAV_MODE) || 'fav';
        return ['fav', 'last', 'off'].includes(mode) ? mode : 'fav';
    }
    function setNavTpMode(mode) { localStorage.setItem(STORAGE_NAV_MODE, mode); updateNavButtonAppearance(); }

    function getDropMode() { return localStorage.getItem(STORAGE_DROP_MODE) || 'icon'; }
    function setDropMode(mode) { localStorage.setItem(STORAGE_DROP_MODE, mode); buildSimpleList(); }

    function getSellConfirmItems() {
        const items = readStoredJSON(STORAGE_SELL_CONFIRM, ['Strange Pheromone', 'Rare Pokémon Picture']);
        return [...new Set([...items, 'Bronze Boss Token', 'Boss Bronze Token'])];
    }
    function setSellConfirmItems(items) {
        localStorage.setItem(STORAGE_SELL_CONFIRM, JSON.stringify(items));
    }

    function getSellLocks() {
        return readStoredJSON(STORAGE_SELL_LOCKS, []);
    }
    function addSellLock(itemName) {
        const locks = getSellLocks();
        if (!locks.includes(itemName)) { locks.push(itemName); localStorage.setItem(STORAGE_SELL_LOCKS, JSON.stringify(locks)); }
    }
    function removeSellLock(itemName) {
        const locks = getSellLocks().filter(n => n !== itemName);
        localStorage.setItem(STORAGE_SELL_LOCKS, JSON.stringify(locks));
    }
    function getNativeItemLocks() { return readStoredJSON(STORAGE_NATIVE_ITEM_LOCKS, []); }
    function setNativeItemLock(itemName, locked) {
        const normalized = String(itemName || '').trim();
        let locks = getNativeItemLocks().filter(name => name !== normalized);
        if (locked && normalized) locks.push(normalized);
        localStorage.setItem(STORAGE_NATIVE_ITEM_LOCKS, JSON.stringify(locks));
    }
    function getItemProtectionReason(entry) {
        const name = String(entry?.name || '').trim().toLowerCase();
        if (isNativeLocked(entry) || getNativeItemLocks().some(item => String(item).trim().toLowerCase() === name)) return 'cadeado nativo do Mark de Cerulean';
        if (getSellLocks().some(item => String(item).trim().toLowerCase() === name)) return 'proteção de venda das configurações do PIW-QOL';
        return '';
    }
    async function togglePortableItemProtection(entry) {
        const normalizedName = String(entry?.name || '').trim().toLowerCase();
        const hasLegacyProtection = getSellLocks().some(item => String(item).trim().toLowerCase() === normalizedName);
        const hasNativeProtection = isNativeLocked(entry)
            || getNativeItemLocks().some(item => String(item).trim().toLowerCase() === normalizedName);
        if (hasLegacyProtection) removeSellLock(entry.name);
        if (hasNativeProtection) {
            entry.locked = true;
            return toggleNativeLock('item', entry);
        }
        if (hasLegacyProtection) return false;
        return toggleNativeLock('item', entry);
    }


    function isDexFastTravelActive() { return localStorage.getItem(STORAGE_DEX_FAST_TRAVEL) === 'true'; }
    function setDexFastTravel(val) { localStorage.setItem(STORAGE_DEX_FAST_TRAVEL, val ? 'true' : 'false'); }

    function isGuardLegendaryActive() { return localStorage.getItem(STORAGE_GUARD_LEGENDARY) !== 'false'; }
    function setGuardLegendary(val) { localStorage.setItem(STORAGE_GUARD_LEGENDARY, val ? 'true' : 'false'); }

    function isHaCompact() { return localStorage.getItem(STORAGE_HA_COMPACT) === 'true'; }
    function setHaCompact(val) { localStorage.setItem(STORAGE_HA_COMPACT, val ? 'true' : 'false'); }
    function isHaDropsVisible() { return localStorage.getItem(STORAGE_HA_DROPS) === 'true'; }
    function setHaDropsVisible(val) { localStorage.setItem(STORAGE_HA_DROPS, val ? 'true' : 'false'); }
    function getDexFilter() { return localStorage.getItem(STORAGE_DEX_FILTER) || 'all'; }
    function setDexFilter(val) { localStorage.setItem(STORAGE_DEX_FILTER, val); }
    function isDexSortedByValue() { return localStorage.getItem(STORAGE_DEX_SORT_VALUE) === 'true'; }
    function setDexSortedByValue(val) { localStorage.setItem(STORAGE_DEX_SORT_VALUE, val ? 'true' : 'false'); }
    function loadCaughtPokemonCache() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_CAUGHT_POKEMON) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    function saveCaughtPokemonCache() {
        localStorage.setItem(STORAGE_CAUGHT_POKEMON, JSON.stringify([...globalCaughtPokemonNames]));
    }
    let caughtPokedexPromise = null;
    function loadCaughtPokedexData(force = false) {
        if (!force && caughtPokedexPromise) return caughtPokedexPromise;
        caughtPokedexPromise = gameApiRequest('/api/game/pokedex')
            .then(payload => {
                const species = Array.isArray(payload?.species) ? payload.species : [];
                const caughtIds = new Set(species.filter(s => s?.caught).map(s => Number(s.id)));
                let changed = false;
                for (const [name, poke] of globalCreatureApiData.entries()) {
                    const pokeId = Number(poke?.pokeId ?? poke?.id);
                    if (Number.isFinite(pokeId) && caughtIds.has(pokeId) && !globalCaughtPokemonNames.has(name)) {
                        globalCaughtPokemonNames.add(name);
                        changed = true;
                    }
                }
                if (changed) {
                    saveCaughtPokemonCache();
                    lastMapRenderSignature = '';
                    buildSimpleList();
                }
            })
            .catch(error => console.warn('⚠️ Falha ao carregar status de captura da Pokédex.', error))
            .finally(() => { caughtPokedexPromise = null; });
        return caughtPokedexPromise;
    }
    function isHuntBulkBuyActive() { return localStorage.getItem(STORAGE_HUNT_BULK_BUY) !== 'false'; }
    function setHuntBulkBuyActive(val) { localStorage.setItem(STORAGE_HUNT_BULK_BUY, val ? 'true' : 'false'); }
    function isHuntSellActive() { return localStorage.getItem(STORAGE_HUNT_SELL) !== 'false'; }
    function setHuntSellActive(val) { localStorage.setItem(STORAGE_HUNT_SELL, val ? 'true' : 'false'); }
    function isMarkEnhancementsActive() { return localStorage.getItem(STORAGE_MARK_ENHANCEMENTS) !== 'false'; }
    function setMarkEnhancementsActive(val) { localStorage.setItem(STORAGE_MARK_ENHANCEMENTS, val ? 'true' : 'false'); }

    function applyMapScriptState() {
        const active = isScriptMapActive();
        const existingContainer = document.getElementById('simple-hunts-container');
        if (active) {
            if (!document.getElementById('simplifier-map-override')) document.head.appendChild(styleMapMod);
            if (existingContainer) existingContainer.style.display = 'block';
            buildSimpleList();
        } else {
            if (document.getElementById('simplifier-map-override')) styleMapMod.remove();
            if (existingContainer) existingContainer.style.display = 'none';
        }
    }

    function applyChatState() {
        const active = isChatActive();
        const chatFab = document.querySelector('.chat-fab');
        const chatBox = document.querySelector('.chat-box');
        if (chatFab) chatFab.style.display = active ? '' : 'none';
        if (chatBox) chatBox.style.display = active ? '' : 'none';
    }

    function getFavorites() {
        return readStoredJSON(STORAGE_FAVS, []);
    }

    function toggleFavorite(huntName) {
        let favs = getFavorites();
        if (favs.includes(huntName)) {
            favs = favs.filter(name => name !== huntName);
            if (localStorage.getItem(STORAGE_PRIMARY_FAVORITE) === huntName) {
                localStorage.removeItem(STORAGE_PRIMARY_FAVORITE);
            }
        }
        else favs.push(huntName);
        localStorage.setItem(STORAGE_FAVS, JSON.stringify(favs));
        lastMapRenderSignature = '';
        updateNavButtonAppearance();
        buildSimpleList();
    }

    function getPrimaryFavorite() {
        const favorite = localStorage.getItem(STORAGE_PRIMARY_FAVORITE);
        return getFavorites().includes(favorite) ? favorite : null;
    }

    function showPrimaryFavoriteSelector({ teleportAfterSelection = true } = {}) {
        const favorites = getFavorites();
        if (!favorites.length) return showScriptNotice('Você não possui nenhuma hunt favorita.');
        document.querySelector('.primary-favorite-backdrop')?.remove();

        const backdrop = document.createElement('div');
        backdrop.className = 'sell-confirm-backdrop primary-favorite-backdrop';
        const modal = document.createElement('div');
        modal.className = 'sell-confirm-modal';
        modal.style.width = 'min(420px,92vw)';
        modal.innerHTML = `
            <div class="sell-confirm-title">
                <span>⭐ Escolher hunt principal</span>
                <button class="primary-favorite-close" type="button" style="margin-left:auto;background:none;border:0;color:#a0aec0;font-size:20px;cursor:pointer;">×</button>
            </div>
            <div class="sell-confirm-body">
                <p>Esta será usada sempre que você clicar no teleporte de favorita. Clique com o botão direito na estrela da barra para trocar depois.</p>
                <div class="primary-favorite-list" style="display:grid;gap:7px;"></div>
            </div>
        `;
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        const close = () => backdrop.remove();
        modal.querySelector('.primary-favorite-close').addEventListener('click', close);
        const selected = getPrimaryFavorite();
        const list = modal.querySelector('.primary-favorite-list');
        favorites.forEach(name => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sell-confirm-btn';
            button.style.cssText = 'display:flex;justify-content:space-between;background:#14222d;color:#e2e8f0;border:1px solid #273f52;';
            button.innerHTML = `<span>${escapeHTML(name)}</span><span>${name === selected ? 'Principal ✓' : 'Selecionar'}</span>`;
            button.addEventListener('click', () => {
                localStorage.setItem(STORAGE_PRIMARY_FAVORITE, name);
                close();
                updateNavButtonAppearance();
                if (teleportAfterSelection) teleportToTarget(name);
            });
            list.appendChild(button);
        });
    }

    const CITY_NAMES = /\b(?:cerulean(?: city)?|pewter(?: city)?|lavender(?: town)?|viridian(?: city)?|cassino|casino)\b/i;
    function isCityName(name) { return CITY_NAMES.test(String(name || '').replace(/\[[^\]]*]/g, ' ').trim()); }
    function isCityMarker(marker, name) {
        const metadata = [
            marker?.className, marker?.type, marker?.kind, marker?.tag, marker?.category,
            marker?.locationType, marker?.dataset?.type, marker?.dataset?.tag, marker?.dataset?.category
        ].filter(Boolean).join(' ');
        return marker?.isCity === true || isCityName(name) || /\b(?:city|cidade|town)\b/i.test(metadata);
    }
    function isKnownNonHuntLocation(name) {
        if (!name) return false;
        if (isCityName(name)) return true;
        const marker = findMappedHunt(name);
        return Boolean(marker && isCityMarker(marker, name));
    }
    function getCityDisplayName(name) {
        if (/pewter|lavender/i.test(name)) return 'Lavender (Pewter)';
        if (/viridian/i.test(name)) return 'Viridian';
        if (/cassino|casino/i.test(name)) return 'Cassino';
        return 'Cerulean';
    }
    function getCityIconStyle(name) {
        const badge = /cerulean/i.test(name) ? '💧' : /pewter|lavender/i.test(name) ? '🪨' : /viridian/i.test(name) ? '🌿' : '🎰';
        return `--city-badge:"${badge}";width:38px;height:38px;`;
    }
    function saveLastHunt(huntName) {
        if (huntName && huntName !== 'Sem Nome' && !isCityName(huntName)) localStorage.setItem(STORAGE_LAST_HUNT, huntName);
    }
    function getLastHunt() { return localStorage.getItem(STORAGE_LAST_HUNT) || null; }

    function resolveHuntNameFromHud() {
        const location = getCurrentHuntLocation();
        if (!location || isCityName(location)) return null;
        const marker = findMappedHunt(location);
        return marker ? (getMarkerName(marker) || location) : null;
    }

    function rememberCurrentHuntFromHud() {
        const huntName = resolveHuntNameFromHud();
        if (huntName) saveLastHunt(huntName);
    }

    function getActivePokemonName() {
        const nameEl = document.querySelector('.phud-name');
        if (cachedLeaderPokemonName) return cachedLeaderPokemonName;
        const text = normalizePokemonName(nameEl?.textContent || '');
        return Object.keys(POKEMON_TYPES).sort((a, b) => b.length - a.length).find(name => text.includes(name)) || text;
    }

    function findMappedHunt(huntName) {
        return globalHuntMarkerData.get(getCleanHuntName(huntName)) || null;
    }

    function clickMappedHunt(huntName) {
        const mappedHunt = findMappedHunt(huntName);
        const slug = getMarkerSlug(mappedHunt);
        if (!slug) return false;

        const guide = `hunt-${slug}`;
        const marker = Array.from(document.querySelectorAll('[data-guide]'))
            .find(element => element.dataset.guide === guide);
        if (!marker) return false;

        marker.click();
        return true;
    }

    function getMapAreaTabs(mapWindow) {
        return Array.from(mapWindow.querySelectorAll('.map-area:not(.locked), .map-plate:not(.locked)'));
    }

    function waitForMapAreaChange(previousTab) {
        return new Promise(resolve => {
            const deadline = Date.now() + 1200;
            const check = () => {
                const activeTab = document.querySelector('.map-area.on, .map-plate.on');
                if (activeTab && activeTab !== previousTab || Date.now() >= deadline) {
                    resolve(activeTab);
                    return;
                }
                requestAnimationFrame(check);
            };
            check();
        });
    }

    async function teleportToTarget(huntName, { silent = false } = {}) {
        const notify = (message, options) => { if (!silent) showScriptNotice(message, options); };
        hideDropTooltip();
        if (!huntName) {
            notify('Nenhuma hunt definida.');
            return false;
        }

        await loadMapMarkersData();

        const mapBtn = document.querySelector('button[data-guide="dock-map"]');
        let mapWindow = document.querySelector('.map-window');

        const mapIsVisible = mapWindow && getComputedStyle(mapWindow).display !== 'none';
        if (!mapIsVisible) {
            if (mapBtn) mapBtn.click();
            mapWindow = await waitForElement('.map-window', 1200);
        }

        mapWindow = mapWindow || document.querySelector('.map-window');
        if (!mapWindow) {
            notify('O mapa não abriu.', { isError: true });
            return false;
        }

        if (clickMappedHunt(huntName)) return true;

        let allTabs = getMapAreaTabs(mapWindow);
        if (allTabs.length === 0) {
            const found = await tryFindMarkerAsync(huntName, 20, 100);
            if (!found) notify(`Hunt "${huntName}" não foi localizada.`, { isError: true });
            return found;
        }

        const activeTab = mapWindow.querySelector('.map-area.on, .map-plate.on');
        if (activeTab) {
            const found = await tryFindMarkerAsync(huntName, 10, 100);
            if (found) return true;
        }

        for (let tabIndex = 0; tabIndex < allTabs.length; tabIndex += 1) {
            const tab = getMapAreaTabs(mapWindow)[tabIndex];
            if (!tab || tab === activeTab) continue;

            tab.click();
            await waitForMapAreaChange(activeTab);
            const found = await tryFindMarkerAsync(huntName, 40, 100);
            if (found) return true;
        }

        notify(`Hunt "${huntName}" não foi localizada em nenhuma área.`, { isError: true });
        return false;
    }

    function waitForElement(selector, timeoutMs) {
        const existing = document.querySelector(selector);
        if (existing) return Promise.resolve(existing);
        return new Promise(resolve => {
            const observer = new MutationObserver(() => {
                const element = document.querySelector(selector);
                if (!element) return;
                observer.disconnect();
                clearTimeout(timeout);
                resolve(element);
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            const timeout = setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeoutMs);
        });
    }

    function tryFindMarkerAsync(huntName, maxAttempts, intervalMs) {
        return new Promise(resolve => {
            let attempts = 0;
            const interval = setInterval(() => {
                if (clickMappedHunt(huntName)) {
                    clearInterval(interval);
                    resolve(true);
                    return;
                }

                const markers = Array.from(document.querySelectorAll('.hunt-marker'));
                const targetMarker = markers.find(m => {
                    const nameEl = m.querySelector('.hunt-name');
                    return nameEl && nameEl.textContent.trim().toLowerCase() === huntName.toLowerCase();
                });

                if (targetMarker) {
                    clearInterval(interval);
                    targetMarker.click();
                    resolve(true);
                } else {
                    attempts++;
                    if (attempts >= maxAttempts) {
                        clearInterval(interval);
                        resolve(false);
                    }
                }
            }, intervalMs);
        });
    }

    function teleportToFavorite() {
        const favs = getFavorites();
        if (favs.length === 0) return showScriptNotice('Você não possui nenhuma hunt favorita.');
        if (favs.length === 1) {
            localStorage.setItem(STORAGE_PRIMARY_FAVORITE, favs[0]);
            return teleportToTarget(favs[0]);
        }
        const primary = getPrimaryFavorite();
        if (!primary) return showPrimaryFavoriteSelector();
        teleportToTarget(primary);
    }

    function teleportToLastHunt() {
        const last = getLastHunt();
        if (!last) return showScriptNotice('Nenhuma última hunt registrada ainda.');
        teleportToTarget(last);
    }

    function handleNavQuickTP() {
        if (getSidebarLocation() !== 'city') {
            teleportToFavorite();
            return;
        }
        const mode = getNavTpMode();
        if (mode === 'fav') teleportToFavorite();
        else if (mode === 'last') teleportToLastHunt();
    }

    function getSidebarLocation() {
        const location = getCurrentHuntLocation();
        if (location) {
            const clean = location.replace(/\[[^\]]*]/g, ' ').trim();
            if (isCityName(clean)) return 'city';
            const marker = findMappedHunt(clean);
            if (marker && !isCityMarker(marker, clean)) return 'hunt';
            if (document.querySelector('[data-guide="capture-bar"], .hunt-ui, .battle-window, .wild-pokemon')) return 'hunt';
            return 'other';
        }
        if (document.querySelector('[data-guide="capture-bar"], .hunt-ui, .battle-window, .wild-pokemon')) return 'hunt';
        return 'unknown';
    }

    function syncSidebarLocation() {
        const sidebar = document.getElementById('script-sidebar');
        if (!sidebar) return;
        const location = getSidebarLocation();
        if (sidebar.dataset.location !== location) {
    sidebar.dataset.location = location;
    if (location === 'hunt') {
        sidebar.querySelectorAll('.script-shop-menu').forEach(menu => { menu.hidden = true; });
        document.querySelector('.portable-depot-backdrop')?.remove();
        document.querySelector('.script-market-backdrop')?.remove();
    }

    const sellBtn = document.getElementById('dock-btn-sell');
    if (sellBtn) sellBtn.style.display = (location === 'city') ? '' : 'none';
}
        updateNavButtonAppearance();
    }

    function updateNavButtonAppearance() {
        const tpBtn = document.getElementById('dock-btn-quick-tp');
        if (!tpBtn) return;
        if (getSidebarLocation() !== 'city') {
            tpBtn.hidden = false;
            if (tpBtn.textContent !== '★') tpBtn.textContent = '★';
            const title = `Teleportar para ${getPrimaryFavorite() || 'Hunt Favorita'}${getFavorites().length > 1 ? ' · botão direito para escolher' : ''}`;
            if (tpBtn.title !== title) tpBtn.title = title;
            return;
        }
        const mode = getNavTpMode();
        tpBtn.hidden = mode === 'off';
        if (mode === 'off') return;
        const label = mode === 'fav' ? '★' : '↺';
        if (tpBtn.textContent !== label) tpBtn.textContent = label;
        const primary = getPrimaryFavorite();
        tpBtn.title = mode === 'fav'
            ? `Teleportar para ${primary || 'Hunt Favorita'}${getFavorites().length > 1 ? ' · botão direito para escolher' : ''}`
            : 'Teleportar para Última Hunt';
    }

    async function returnToMainCity() {
        const button = document.getElementById('dock-btn-city');
        if (button?.disabled) return;
        if (button) button.disabled = true;
        try {
            const moved = await teleportToTarget('Cerulean', { silent: true });
            if (!moved) showScriptNotice('Não foi possível localizar Cerulean no mapa.', { isError: true });
        } finally {
            if (button) button.disabled = false;
        }
    }

    function injectQuickTPButton() {
        let sidebar = document.getElementById('script-sidebar');
        if (!sidebar) {
            sidebar = document.createElement('div');
            sidebar.id = 'script-sidebar';
            document.body.appendChild(sidebar);
        }

        let tpBtn = document.getElementById('dock-btn-quick-tp');
        if (!tpBtn) {
            tpBtn = document.createElement('button');
            tpBtn.id = 'dock-btn-quick-tp';
            tpBtn.className = 'dock-btn';
            tpBtn.type = 'button';
            tpBtn.addEventListener('click', handleNavQuickTP);
            tpBtn.addEventListener('contextmenu', event => {
                if (getSidebarLocation() === 'city' && getNavTpMode() !== 'fav') return;
                event.preventDefault();
                showPrimaryFavoriteSelector({ teleportAfterSelection: false });
            });
            sidebar.appendChild(tpBtn);
            updateNavButtonAppearance();
        } else if (tpBtn.parentElement !== sidebar) {
            sidebar.appendChild(tpBtn);
        }

        if (!document.getElementById('dock-btn-shops')) {
    // 🏪 Comprar (abre direto no tab Buy)
    const buyBtn = document.createElement('button');
    buyBtn.id = 'dock-btn-shops';
    buyBtn.className = 'dock-btn';
    buyBtn.type = 'button';
    buyBtn.textContent = '🏪';
    buyBtn.title = 'Comprar (Poké Bolas & Poções)';
    buyBtn.addEventListener('click', () => showPortableShop('buy'));
    sidebar.appendChild(buyBtn);

    // 💰 Vender (abre direto no tab Sell Items)
    const sellBtn = document.createElement('button');
    sellBtn.id = 'dock-btn-sell';
    sellBtn.className = 'dock-btn';
    sellBtn.type = 'button';
    sellBtn.textContent = '💰';
    sellBtn.title = 'Vender Itens & Pokémon';
    sellBtn.addEventListener('click', () => showPortableShop('sell-items'));
    sidebar.appendChild(sellBtn);
}

        if (!document.getElementById('dock-btn-depot')) {
            const depotButton = document.createElement('button');
            depotButton.id = 'dock-btn-depot';
            depotButton.className = 'dock-btn';
            depotButton.type = 'button';
            depotButton.textContent = '📦';
            depotButton.title = 'Depot';
            depotButton.addEventListener('click', showPortableDepot);
            sidebar.appendChild(depotButton);
        }

        if (!document.getElementById('dock-btn-city')) {
            const cityButton = document.createElement('button');
            cityButton.id = 'dock-btn-city';
            cityButton.className = 'dock-btn';
            cityButton.type = 'button';
            cityButton.title = 'Voltar para Cerulean';
            cityButton.setAttribute('aria-label', 'Voltar para Cerulean');
            cityButton.textContent = '🏠';
            cityButton.addEventListener('click', returnToMainCity);
            sidebar.appendChild(cityButton);
        }
        syncSidebarLocation();
    }

    let configDropdownCloseHandler = null;

    function injectConfigTab() {
        const cfgWindow = document.querySelector('.cfg-window');
        if (!cfgWindow || cfgWindow.querySelector('.cfg-tab-mods')) return;

        const cfgTabs = cfgWindow.querySelector('.cfg-tabs');
        const cfgBody = cfgWindow.querySelector('.cfg-body');
        if (!cfgTabs || !cfgBody) return;

        const modsTab = document.createElement('button');
        modsTab.className = 'cfg-tab cfg-tab-mods';
        modsTab.type = 'button';
        modsTab.textContent = tr('scriptMods');

        let originalContent = cfgBody.querySelector('.cfg-original-content');
        if (!originalContent) {
            originalContent = document.createElement('div');
            originalContent.className = 'cfg-original-content';
            while (cfgBody.firstChild) originalContent.appendChild(cfgBody.firstChild);
            cfgBody.appendChild(originalContent);
        }

        let modsContent = cfgBody.querySelector('.cfg-mods-content');
        if (!modsContent) {
            modsContent = document.createElement('div');
            modsContent.className = 'cfg-mods-content';
            modsContent.style.display = 'none';
            cfgBody.appendChild(modsContent);
        }

        cfgTabs.appendChild(modsTab);

        function updateModsUI() {
            const mapActive = isScriptMapActive();
            const chatActiveState = isChatActive();
            const navMode = getNavTpMode();
            const dropMode = getDropMode();
            const sellConfirmItems = getSellConfirmItems();

            const toggleRow = ({ className, prefKey, checked, title, description, wide = false }) => `
                <label class="cfg-row${wide ? ' script-mods-wide' : ''}">
                    <input type="checkbox" class="${className}"${prefKey ? ` data-pref-key="${prefKey}"` : ''}${checked ? ' checked' : ''}>
                    <span class="cfg-label"><b>${title}</b><span>${description}</span></span>
                </label>`;

            const segmentRow = ({ id, extraClass = '', title, description, buttons }) => `
                <div class="cfg-row ${extraClass}"${id ? ` id="${id}"` : ''}>
                    <div class="cfg-label"><b>${title}</b><span>${description}</span></div>
                    <div class="cfg-seg">
                        ${buttons.map(([className, label, on]) => `<button type="button" class="cfg-seg-btn ${className}${on ? ' on' : ''}">${label}</button>`).join('')}
                    </div>
                </div>`;

            const sublistRow = ({ title, description, items }) => `
                <div class="cfg-row script-mods-wide">
                    <div class="cfg-label"><b>${title}</b><span>${description}</span></div>
                    <div class="cfg-mods-sublist">
                        ${items.map(([className, checked, itemTitle, itemDescription]) => `
                            <label>
                                <input type="checkbox" class="${className}"${checked ? ' checked' : ''}>
                                <span class="cfg-label"><b>${itemTitle}</b><span>${itemDescription}</span></span>
                            </label>`).join('')}
                    </div>
                </div>`;

            const category = (icon, title, rows) => `
                <section class="script-mod-category">
                    <h3><span>${icon}</span>${title}</h3>
                    <div class="script-mod-category-grid">${rows.join('')}</div>
                </section>`;

            const prefToggle = (className, key, title, description) =>
                toggleRow({ className, prefKey: key, checked: preferenceEnabled(key), title, description });

            modsContent.innerHTML = `
                <div class="script-mods-grid">
                    <div class="script-mods-title">⚙️ ${tr('modSettings')}</div>

                    ${category('🗺️', 'Mapa e navegação', [
                        segmentRow({
                            title: tr('simplifiedMap'), description: tr('simplifiedMapDesc'),
                            buttons: [['btn-map-on', tr('enabled'), mapActive], ['btn-map-off', tr('disabled'), !mapActive]]
                        }),
                        segmentRow({
                            id: 'sub-map-feature-row', extraClass: mapActive ? '' : 'mod-disabled',
                            title: tr('dropsPreview'), description: tr('dropsPreviewDesc'),
                            buttons: [
                                ['btn-drop-hover', 'Hover', dropMode === 'hover'],
                                ['btn-drop-icon', tr('icon'), dropMode === 'icon'],
                                ['btn-drop-off', tr('hidden'), dropMode === 'off']
                            ]
                        }),
                        segmentRow({
                            title: tr('navAction'), description: tr('navActionDesc'),
                            buttons: [
                                ['btn-nav-fav', `★ ${tr('favorite')}`, navMode === 'fav'],
                                ['btn-nav-last', `↺ ${tr('last')}`, navMode === 'last'],
                                ['btn-nav-off', tr('none'), navMode === 'off']
                            ]
                        }),
                        toggleRow({
                            className: 'btn-dex-ft', checked: isDexFastTravelActive(),
                            title: 'Pokédex Fast Travel', description: tr('dexFastTravelDesc')
                        })
                    ])}

                    ${category('⚔️', 'Hunts', [
                        toggleRow({
                            className: 'cfg-auto-reconnect', checked: isAutoReconnectActive(),
                            title: 'Auto-reconnect da hunt',
                            description: 'Quando a hunt fica 30 segundos sem responder, sai e entra na mesma hunt, aguarda até 30 segundos pela confirmação e aumenta o intervalo entre novas tentativas. Durante bosses, nunca envia leave-hunt.'
                        }),
                        prefToggle('cfg-compare-window', STORAGE_COMPARE_WINDOW, 'Comparação de hunts', 'Exibe a janela móvel e redimensionável de comparação.'),
                        sublistRow({
                            title: tr('huntFeatures'), description: tr('huntFeaturesDesc'),
                            items: [
                                ['btn-hunt-bulk', isHuntBulkBuyActive(), tr('bulkBuy'), tr('bulkBuyDesc')],
                                ['btn-hunt-sell', isHuntSellActive(), tr('huntSell'), tr('huntSellDesc')]
                            ]
                        })
                    ])}

                    ${category('🏪', 'Loja do Mark', [
                        prefToggle('cfg-mark-quick-buy', STORAGE_MARK_QUICK_BUY, 'Compras rápidas no Mark', 'Mostra 1, 10, 100, 1.000 e 10.000 em cada produto.'),
                        prefToggle('cfg-mark-quality-picker', STORAGE_MARK_QUALITY_PICKER, 'Seletor de qualidades do Mark', 'Agrupa as qualidades em um seletor múltiplo.'),
                        toggleRow({
                            className: 'btn-mark-enhancements', checked: isMarkEnhancementsActive(),
                            title: tr('cityMark'), description: tr('cityMarkDesc')
                        })
                    ])}

                    ${category('🐾', 'Pokémon', [
                        prefToggle('cfg-show-quality-potential', STORAGE_SHOW_QUALITY_POTENTIAL, 'Porcentagem de potencial',
                            'Exibe uma estimativa (75% qualidade + 25% IV) junto à qualidade no time, log de capturas e venda em massa. Não é um valor oficial do jogo, mas estima a força do Pokémon.'),
                        prefToggle('cfg-show-pokemon-sell-icon', STORAGE_SHOW_POKEMON_SELL_ICON, 'Imagem na venda de Pokémon',
                            'Exibe a imagem da Pokédex antes do nome na tela de venda da hunt.')
                    ])}

                    ${category('🛡️', 'Proteções e vendas', [
                        toggleRow({
                            className: 'btn-guard-leg', checked: isGuardLegendaryActive(),
                            title: tr('protectLegendary'), description: tr('selectAllGuardsDesc')
                        }),
                        `<div class="cfg-row script-mods-wide">
                            <div class="cfg-label"><b>${tr('sellConfirmation')}</b><span>${tr('protectedItems')}</span></div>
                            <div class="cfg-sell-confirm">
                                <div id="cfg-sell-selected-list"></div>
                                <div class="cfg-sell-dd-wrap">
                                    <button type="button" id="cfg-sell-dd-btn">${tr('selectItems')}</button>
                                    <div id="cfg-sell-dropdown-menu">
                                        <input type="text" id="cfg-sell-search" placeholder="${tr('search')}">
                                        <div id="cfg-sell-dropdown"></div>
                                    </div>
                                </div>
                            </div>
                        </div>`
                    ])}

                    ${category('🪟', 'Interface', [
                        prefToggle('cfg-custom-scrollbars', STORAGE_CUSTOM_SCROLLBARS, 'Scrollbars minimalistas', 'Substitui as barras brancas pelo estilo transparente.'),
                        segmentRow({
                            title: tr('chatInterface'), description: tr('chatInterfaceDesc'),
                            buttons: [['btn-chat-on', tr('show'), chatActiveState], ['btn-chat-off', tr('hide'), !chatActiveState]]
                        })
                    ])}

                    ${category('🔤', 'Fontes', [
                        `<div class="cfg-row script-mods-wide">
                            <div class="cfg-label">
                                <b>Fonte do jogo</b>
                                <span>Aplica a mesma família tipográfica a todas as janelas e controles.</span>
                            </div>
                            <select class="cfg-game-font cfg-mods-field">
                                <option value="barlow">Barlow (original)</option>
                                <option value="verdana">Verdana</option>
                                <option value="arial">Arial</option>
                                <option value="system">Fonte do sistema</option>
                                <option value="cinzel">Cinzel</option>
                                <option value="custom">Personalizada</option>
                            </select>
                            <input class="cfg-custom-font cfg-mods-field" type="text" placeholder='Ex.: "Trebuchet MS", sans-serif'>
                            <div class="cfg-font-file-row">
                                <input class="cfg-custom-font-file" type="file" accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf" hidden>
                                <button class="cfg-seg-btn cfg-choose-font-file" type="button">Abrir arquivo de fonte…</button>
                                <span class="cfg-font-file-name">${escapeHTML(localStorage.getItem(STORAGE_CUSTOM_FONT_NAME) || 'Nenhum arquivo selecionado')}</span>
                            </div>
                        </div>`,
                        prefToggle('cfg-unified-fonts', STORAGE_UNIFIED_FONTS, 'Fonte unificada', 'Aplica a fonte escolhida às janelas e controles do jogo.')
                    ])}
                </div>
            `;

            modsContent.querySelector('.cfg-game-font').value = getGameFont();
            modsContent.querySelector('.cfg-game-font').addEventListener('change', event => applyGameFont(event.target.value));
            modsContent.querySelector('.cfg-custom-font').value = getCustomFont();
            modsContent.querySelector('.cfg-custom-font').addEventListener('input', event => {
                localStorage.setItem(STORAGE_CUSTOM_FONT, event.target.value.replace(/[;{}]/g, ''));
                if (modsContent.querySelector('.cfg-game-font').value === 'custom') applyGameFont('custom');
            });
            const customFontFile = modsContent.querySelector('.cfg-custom-font-file');
            modsContent.querySelector('.cfg-choose-font-file').addEventListener('click', () => customFontFile.click());
            customFontFile.addEventListener('change', async () => {
                const file = customFontFile.files?.[0];
                if (!file) return;
                const extension = file.name.split('.').pop()?.toLowerCase();
                if (!['woff', 'woff2', 'ttf', 'otf'].includes(extension)) {
                    showScriptNotice('Escolha um arquivo .woff, .woff2, .ttf ou .otf.', { title: 'Fonte inválida', isError: true });
                    return;
                }
                try {
                    const buffer = await file.arrayBuffer();
                    const face = new FontFace(CUSTOM_FONT_FAMILY, buffer);
                    await face.load();
                    document.fonts.add(face);
                    await storeCustomFontFile(buffer);
                    localStorage.setItem(STORAGE_CUSTOM_FONT, `"${CUSTOM_FONT_FAMILY}", sans-serif`);
                    localStorage.setItem(STORAGE_CUSTOM_FONT_NAME, file.name);
                    modsContent.querySelector('.cfg-custom-font').value = `"${CUSTOM_FONT_FAMILY}", sans-serif`;
                    modsContent.querySelector('.cfg-game-font').value = 'custom';
                    modsContent.querySelector('.cfg-font-file-name').textContent = file.name;
                    applyGameFont('custom');
                    showScriptNotice(`Fonte “${file.name}” aplicada e salva.`, { title: 'Fonte personalizada' });
                } catch (error) {
                    showScriptNotice(`Não foi possível carregar a fonte: ${error.message}`, { title: 'Erro na fonte', isError: true });
                }
            });
            modsContent.querySelector('.cfg-auto-reconnect').checked = isAutoReconnectActive();
            modsContent.querySelector('.cfg-auto-reconnect').addEventListener('change', event => {
                localStorage.setItem(STORAGE_AUTO_RECONNECT, String(event.target.checked));
                socketDownSince = 0;
                resetAutoReconnectFailures();
                if (event.target.checked) {
                    lastHuntSocketActivityAt = Date.now();
                    lastCaptureBarSignature = document.querySelector('[data-guide="capture-bar"]')?.innerHTML || '';
                } else {
                    bossMaxLogged = false;
                    cancelScheduledAutoReconnectReload();
                }
            });
            modsContent.querySelectorAll('[data-pref-key]').forEach(control => control.addEventListener('change', event => {
                localStorage.setItem(event.target.dataset.prefKey, String(event.target.checked));
                applyVisualPreferences();
                if (event.target.dataset.prefKey === STORAGE_SHOW_QUALITY_POTENTIAL) {
                    setTimeout(enhancePartyQuality, 0);
                }
                if (event.target.dataset.prefKey === STORAGE_COMPARE_WINDOW) {
                    document.querySelector('.ha-script-actions')?.remove();
                    trackHuntAnalyzer();
                    if (!event.target.checked) document.querySelector('.ha-compare-backdrop')?.remove();
                }
                const mkWindow = findNativeMarkWindow();
                if (mkWindow) {
                    if (!preferenceEnabled(STORAGE_MARK_QUICK_BUY)) {
                        mkWindow.querySelectorAll('.script-mark-row-buy').forEach(node => node.remove());
                        mkWindow.querySelectorAll('button.mk-buy').forEach(button => button.style.removeProperty('display'));
                        mkWindow.querySelector('.mk-qtybar')?.style.removeProperty('display');
                    }
                    if (!preferenceEnabled(STORAGE_MARK_QUALITY_PICKER)) {
                        mkWindow.querySelector('.script-quality-multiselect')?.remove();
                        mkWindow.querySelector('.script-quality-dropdown')?.remove();
                        markQualityMenuOpen = false;
                        mkWindow.querySelectorAll('[data-script-quality-native]').forEach(button => {
                            button.style.removeProperty('display');
                            delete button.dataset.scriptQualityNative;
                        });
                    }
                    injectShopEnhancements();
                }
            }));

            modsContent.querySelector('.btn-nav-fav').addEventListener('click', () => { setNavTpMode('fav'); updateModsUI(); });
            modsContent.querySelector('.btn-nav-last').addEventListener('click', () => { setNavTpMode('last'); updateModsUI(); });
            modsContent.querySelector('.btn-nav-off').addEventListener('click', () => { setNavTpMode('off'); updateModsUI(); });

            modsContent.querySelector('.btn-drop-hover').addEventListener('click', () => { setDropMode('hover'); updateModsUI(); });
            modsContent.querySelector('.btn-drop-icon').addEventListener('click', () => { setDropMode('icon'); updateModsUI(); });
            modsContent.querySelector('.btn-drop-off').addEventListener('click', () => { setDropMode('off'); updateModsUI(); });

            modsContent.querySelector('.btn-map-on').addEventListener('click', () => {
                setScriptMapActive(true);
                document.getElementById('sub-map-feature-row').classList.remove('mod-disabled');
                updateModsUI();
            });
            modsContent.querySelector('.btn-map-off').addEventListener('click', () => {
                setScriptMapActive(false);
                document.getElementById('sub-map-feature-row').classList.add('mod-disabled');
                updateModsUI();
            });

            modsContent.querySelector('.btn-chat-on').addEventListener('click', () => { setChatActive(true); updateModsUI(); });
            modsContent.querySelector('.btn-chat-off').addEventListener('click', () => { setChatActive(false); updateModsUI(); });

            modsContent.querySelector('.btn-dex-ft').addEventListener('change', (e) => {
                setDexFastTravel(e.target.checked);
            });

            modsContent.querySelector('.btn-guard-leg').addEventListener('change', (e) => {
                setGuardLegendary(e.target.checked);
            });
            modsContent.querySelector('.btn-hunt-bulk').addEventListener('change', e => {
                setHuntBulkBuyActive(e.target.checked);
                const ballWindow = document.querySelector('.ball-window');
                if (ballWindow) injectHuntBallEnhancements(ballWindow);
            });
            modsContent.querySelector('.btn-hunt-sell').addEventListener('change', e => {
                setHuntSellActive(e.target.checked);
                suppressHuntServiceIcons();
                const ballWindow = document.querySelector('.ball-window');
                if (ballWindow) injectHuntBallEnhancements(ballWindow);
            });
            modsContent.querySelector('.btn-mark-enhancements').addEventListener('change', e => setMarkEnhancementsActive(e.target.checked));

            const selectedListEl = modsContent.querySelector('#cfg-sell-selected-list');
            const ddBtn = modsContent.querySelector('#cfg-sell-dd-btn');
            const ddMenu = modsContent.querySelector('#cfg-sell-dropdown-menu');
            const searchInputEl = modsContent.querySelector('#cfg-sell-search');
            const dropdownEl = modsContent.querySelector('#cfg-sell-dropdown');

            ddBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                ddMenu.style.display = ddMenu.style.display === 'none' ? 'block' : 'none';
                if (ddMenu.style.display === 'block') {
                    renderDropdown();
                    searchInputEl.focus();
                }
            });

            if (configDropdownCloseHandler) {
                document.removeEventListener('click', configDropdownCloseHandler);
            }
            configDropdownCloseHandler = (e) => {
                if (!ddMenu.contains(e.target) && e.target !== ddBtn) {
                    ddMenu.style.display = 'none';
                }
            };
            document.addEventListener('click', configDropdownCloseHandler);

            let uniqueItems = null;

            function initUniqueItems() {
                if (uniqueItems) return;
                uniqueItems = [];
                const seenNames = new Set();
                for (const item of globalItemApiData.values()) {
                    const name = item.name || item.title;
                    if (name && !seenNames.has(name)) {
                        seenNames.add(name);
                        uniqueItems.push(item);
                    }
                }
                uniqueItems.sort((a, b) => (a.name || a.title).localeCompare(b.name || b.title));
            }

            function renderSelected() {
                const items = getSellConfirmItems();
                selectedListEl.innerHTML = '';
                if (items.length === 0) {
                    selectedListEl.innerHTML = `<span style="color:#718096; font-size:12px; margin:auto;">${tr('noProtected')}</span>`;
                } else {
                    items.forEach(itemName => {
                        const iconHTML = resolveItemIcon(itemName);
                        const tag = document.createElement('div');
                        tag.style = 'display:flex; justify-content:space-between; align-items:center; background:#1a2d3a; border:1px solid #2b4c66; padding:4px 8px; border-radius:4px; font-size:12px;';

                        const leftDiv = document.createElement('div');
                        leftDiv.style = 'display:flex; align-items:center; gap:6px; color:#e2e8f0;';
                        leftDiv.innerHTML = `${iconHTML} <span>${itemName}</span>`;

                        const rmBtn = document.createElement('span');
                        rmBtn.innerHTML = '×';
                        rmBtn.style = 'cursor:pointer; color:#f56565; font-weight:bold; font-size:14px;';
                        rmBtn.addEventListener('click', () => {
                            setSellConfirmItems(items.filter(i => i !== itemName));
                            renderSelected();
                            if (ddMenu.style.display === 'block') renderDropdown();
                        });

                        tag.appendChild(leftDiv);
                        tag.appendChild(rmBtn);
                        selectedListEl.appendChild(tag);
                    });
                }
            }

            function renderDropdown() {
                initUniqueItems();
                const query = searchInputEl.value.toLowerCase().trim();
                const selectedItems = getSellConfirmItems();
                dropdownEl.innerHTML = '';

                const filtered = query ? uniqueItems.filter(item => (item.name || item.title).toLowerCase().includes(query)) : uniqueItems;
                const toShow = filtered.slice(0, 50);

                if (toShow.length === 0) {
                    dropdownEl.innerHTML = `<div style="padding:6px; color:#718096; font-size:12px; text-align:center;">${tr('noItemFound')}</div>`;
                    return;
                }

                toShow.forEach(item => {
                    const itemName = item.name || item.title;
                    const isChecked = selectedItems.includes(itemName);
                    const iconHTML = resolveItemIcon(itemName);

                    const row = document.createElement('label');
                    row.style = 'display:flex; align-items:center; padding:6px 10px; cursor:pointer; border-bottom:1px solid #1a2d3a; font-size:13px;';
                    row.addEventListener('mouseenter', () => row.style.background = '#14222d');
                    row.addEventListener('mouseleave', () => row.style.background = 'transparent');

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = isChecked;
                    cb.style.marginRight = '8px';
                    cb.addEventListener('change', () => {
                        let current = getSellConfirmItems();
                        if (cb.checked && !current.includes(itemName)) current.push(itemName);
                        else if (!cb.checked) current = current.filter(i => i !== itemName);
                        setSellConfirmItems(current);
                        renderSelected();
                    });

                    const nameSpan = document.createElement('span');
                    nameSpan.textContent = itemName;
                    nameSpan.style.color = '#e2e8f0';

                    row.appendChild(cb);
                    row.insertAdjacentHTML('beforeend', iconHTML);
                    row.appendChild(nameSpan);
                    dropdownEl.appendChild(row);
                });
            }

            searchInputEl.addEventListener('input', renderDropdown);
            renderSelected();
        }

        const tabsList = Array.from(cfgTabs.querySelectorAll('.cfg-tab'));
        tabsList.forEach(tab => {
            tab.addEventListener('click', () => {
                tabsList.forEach(t => t.classList.remove('on'));
                tab.classList.add('on');
                if (tab.classList.contains('cfg-tab-mods')) {
                    cfgWindow.classList.add('script-mods-open');
                    originalContent.style.display = 'none';
                    modsContent.style.display = 'block';
                    updateModsUI();
                } else {
                    cfgWindow.classList.remove('script-mods-open');
                    modsContent.style.display = 'none';
                    originalContent.style.display = 'block';
                }
            });
        });
    }

    function buildSimpleList() {
        if (!isScriptMapActive() || isRendering) return;
        isRendering = true;

        try {
            const mapWindow = document.querySelector('.map-window');
            const mapBody = document.querySelector('.map-body');

            if (!mapWindow || !mapBody) { isRendering = false; return; }
            if (mapWindow.classList.contains('invisible-check') || !mapWindow.getClientRects().length) {
                mapWindow.dataset.scriptMapWasOpen = 'false';
                isRendering = false;
                return;
            }
            const openedNow = mapWindow.dataset.scriptMapWasOpen !== 'true';
            mapWindow.dataset.scriptMapWasOpen = 'true';
            simplifyNativeMapControls(mapWindow);

            let viewTabs = document.getElementById('script-map-view-tabs');
            if (!viewTabs) {
                viewTabs = document.createElement('div');
                viewTabs.id = 'script-map-view-tabs';
                viewTabs.style = 'display:contents;';
                viewTabs.innerHTML = '<button type="button" data-view="cities" class="map-area script-city-area">Cidades</button>';
                viewTabs.addEventListener('click', event => {
                    const button = event.target.closest('[data-view]');
                    if (!button) return;
                    mapWindow.dataset.scriptMapView = button.dataset.view;
                    lastMapRenderSignature = '';
                    buildSimpleList();
                });
                const nativeAreas = mapWindow.querySelectorAll('.map-area, .map-plate');
                const nativeAreaParent = nativeAreas[0]?.parentElement;
                (nativeAreaParent || mapBody).appendChild(viewTabs);
                nativeAreas.forEach(area => area.addEventListener('click', () => {
                    mapWindow.dataset.scriptMapView = 'hunts';
                    lastMapRenderSignature = '';
                    buildSimpleList();
                }));
            }
            const viewMode = mapWindow.dataset.scriptMapView || 'hunts';
            viewTabs.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('on', button.dataset.view === viewMode));

                        let customFilterBar = document.getElementById('custom-hunts-filter-bar');
            if (!customFilterBar) {
                customFilterBar = document.createElement('div');
                customFilterBar.id = 'custom-hunts-filter-bar';
                customFilterBar.style = `
                    display: grid; grid-template-columns: minmax(175px,1.4fr) minmax(115px,1fr) minmax(145px,1fr) minmax(90px,0.7fr) minmax(90px,0.7fr);
                    gap: 8px; margin-top: 8px; margin-bottom: 4px; font-size: 13px;
                `;

                customFilterBar.innerHTML = `
                    <select id="sort-hunts-select" title="Ordenar hunts" style="background:#0c161f;color:#cbd5e0;border:1px solid #1a2d3a;padding:6px 10px;border-radius:6px;outline:none;font-family:inherit;cursor:pointer;">
                        <option value="">Sem ordenação</option>
                        <option value="price_desc">Preço: Maior -> Menor</option>
                        <option value="price_asc">Preço: Menor -> Maior</option>
                        <option value="eff_desc">Efetividade: Maior Vantagem</option>
                        <option value="xp_desc">Somente XP: Maior XP</option>
                    </select>
                    <select id="filter-hunts-type" title="Filtrar por tipo" style="background:#0c161f;color:#cbd5e0;border:1px solid #1a2d3a;padding:6px 10px;border-radius:6px;outline:none;font-family:inherit;cursor:pointer;">
                        <option value="">Todos os tipos</option>
                    </select>
                    <select id="filter-hunts-access" title="Filtrar por nível" style="background:#0c161f;color:#cbd5e0;border:1px solid #1a2d3a;padding:6px 10px;border-radius:6px;outline:none;font-family:inherit;cursor:pointer;">
                        <option value="all">Selecione um filtro</option>
                        <option value="accessible">Somente acessíveis</option>
                        <option value="favorites">Favoritas acessíveis</option>
                        <option value="advantage">Com vantagem de tipo</option>
                        <option value="neutral">Efetividade neutra</option>
                        <option value="disadvantage">Com desvantagem de tipo</option>
                        <option value="locked">Hunts bloqueadas</option>
                        <option value="not_favorites">Não favoritas</option>
                    </select>
                    <input id="filter-hunts-level-min" type="number" min="1" placeholder="Nv mín." title="Nível mínimo" style="background:#0c161f;color:#cbd5e0;border:1px solid #1a2d3a;padding:6px 8px;border-radius:6px;outline:none;font-family:inherit;">
                    <input id="filter-hunts-level-max" type="number" min="1" placeholder="Nv máx." title="Nível máximo" style="background:#0c161f;color:#cbd5e0;border:1px solid #1a2d3a;padding:6px 8px;border-radius:6px;outline:none;font-family:inherit;">
                `;
                mapBody.appendChild(customFilterBar);

                const persistFiltersFromBar = () => {
                    const current = getMapFilters();
                    setMapFilters({
                        ...current,
                        sort: customFilterBar.querySelector('#sort-hunts-select').value,
                        type: customFilterBar.querySelector('#filter-hunts-type').value,
                        access: customFilterBar.querySelector('#filter-hunts-access').value,
                        levelMin: customFilterBar.querySelector('#filter-hunts-level-min').value,
                        levelMax: customFilterBar.querySelector('#filter-hunts-level-max').value
                    });
                    lastMapRenderSignature = '';
                    isRendering = false;
                    buildSimpleList();
                };

                customFilterBar.addEventListener('change', persistFiltersFromBar);
                customFilterBar.addEventListener('input', persistFiltersFromBar);
            }

            // Reaplica os valores salvos em cada build (o typeSelect é repovoado
            // dinamicamente mais abaixo, então precisa ser reavaliado depois).
            {
                const savedFilters = getMapFilters();
                const sortEl = customFilterBar.querySelector('#sort-hunts-select');
                const typeEl = customFilterBar.querySelector('#filter-hunts-type');
                const accessEl = customFilterBar.querySelector('#filter-hunts-access');
                const levelMinEl = customFilterBar.querySelector('#filter-hunts-level-min');
                const levelMaxEl = customFilterBar.querySelector('#filter-hunts-level-max');
                if (sortEl && !sortEl.value && savedFilters.sort) sortEl.value = savedFilters.sort;
                if (accessEl && savedFilters.access) accessEl.value = savedFilters.access;
                if (levelMinEl && !levelMinEl.value && savedFilters.levelMin) levelMinEl.value = savedFilters.levelMin;
                if (levelMaxEl && !levelMaxEl.value && savedFilters.levelMax) levelMaxEl.value = savedFilters.levelMax;
                // O typeEl é repovoado mais abaixo neste mesmo build — não define aqui.
            }

            let captureFilterBar = document.getElementById('custom-hunts-capture-bar');
            if (!captureFilterBar) {
                const savedFilters = getMapFilters();
                captureFilterBar = document.createElement('div');
                captureFilterBar.id = 'custom-hunts-capture-bar';
                captureFilterBar.className = 'dex-script-controls';
                captureFilterBar.style = 'margin-top: 4px; border-top: none; padding: 0;';
                captureFilterBar.innerHTML = `
                    <button class="dex-fbtn" data-captured="yes" type="button" title="Mostrar apenas pokémons já capturados">✓ Capturados</button>
                    <button class="dex-fbtn" data-captured="no" type="button" title="Mostrar apenas pokémons ainda não capturados">✗ Não Capturados</button>
                    <button class="dex-fbtn script-cl-reset-filters" type="button" title="Limpar todos os filtros do mapa" style="margin-left:auto;color:#feb2b2;border-color:#71313c;">🗑 Limpar filtros</button>
                `;
                mapBody.appendChild(captureFilterBar);

                captureFilterBar.dataset.active = savedFilters.captured || '';
                captureFilterBar.querySelectorAll('.dex-fbtn[data-captured]').forEach(btn => {
                    btn.classList.toggle('on', btn.dataset.captured === captureFilterBar.dataset.active);
                });

                                captureFilterBar.addEventListener('click', (e) => {
                    const resetBtn = e.target.closest('.script-cl-reset-filters');
                    if (resetBtn) {
                        clearMapFilters();
                        const nativeSearch = document.querySelector('.map-filter-q');
                        if (nativeSearch) nativeSearch.value = '';
                        customFilterBar.querySelector('#sort-hunts-select').value = '';
                        customFilterBar.querySelector('#filter-hunts-type').value = '';
                        customFilterBar.querySelector('#filter-hunts-access').value = 'all';
                        customFilterBar.querySelector('#filter-hunts-level-min').value = '';
                        customFilterBar.querySelector('#filter-hunts-level-max').value = '';
                        captureFilterBar.dataset.active = '';
                        captureFilterBar.querySelectorAll('.dex-fbtn[data-captured]').forEach(b => b.classList.remove('on'));
                        lastMapRenderSignature = '';
                        isRendering = false;
                        buildSimpleList();
                        return;
                    }
                    const btn = e.target.closest('.dex-fbtn[data-captured]');
                    if (!btn) return;
                    const clicked = btn.dataset.captured;
                    captureFilterBar.dataset.active = captureFilterBar.dataset.active === clicked ? '' : clicked;
                    captureFilterBar.querySelectorAll('.dex-fbtn[data-captured]').forEach(b => {
                        b.classList.toggle('on', b.dataset.captured === captureFilterBar.dataset.active);
                    });
                    setMapFilters({ ...getMapFilters(), captured: captureFilterBar.dataset.active });
                    lastMapRenderSignature = '';
                    isRendering = false;
                    buildSimpleList();
                });
            }
            customFilterBar.style.display = viewMode === 'cities' ? 'none' : 'grid';
            captureFilterBar.style.display = viewMode === 'cities' ? 'none' : '';

            let simpleContainer = document.getElementById('simple-hunts-container');
            if (!simpleContainer) {
                simpleContainer = document.createElement('div');
                simpleContainer.id = 'simple-hunts-container';
                simpleContainer.style = `
                    width: 100%; max-height: 480px; overflow-y: auto; background: #0d161d;
                    border: 1px solid #1a2d3a; border-radius: 6px; padding: 12px;
                    box-sizing: border-box; font-family: sans-serif; margin-top: 6px;
                `;
                mapBody.appendChild(simpleContainer);
            }

            const searchInput = document.querySelector('.map-filter-q');
            const savedFiltersForSearch = getMapFilters();
            if (searchInput) {
                if (!searchInput.dataset.scriptFilterBound) {
                    searchInput.dataset.scriptFilterBound = 'true';
                    searchInput.value = savedFiltersForSearch.search || '';
                    searchInput.addEventListener('input', () => {
                        setMapFilters({ ...getMapFilters(), search: searchInput.value });
                        lastMapRenderSignature = '';
                        isRendering = false;
                        buildSimpleList();
                    });
                } else if (savedFiltersForSearch.search && searchInput.value !== savedFiltersForSearch.search) {
                    searchInput.value = savedFiltersForSearch.search;
                }
            }
            const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

            const markers = Array.from(document.querySelectorAll('.hunt-marker'));
            const favorites = getFavorites();
            const activePkmn = getActivePokemonName();
            const activePkmnTypes = cachedLeaderPokemonTypes.length ? cachedLeaderPokemonTypes : (POKEMON_TYPES[activePkmn] || []);
            const domTrainerLevel = readTrainerLevelFromDOM();
            if (openedNow) {
                mapWindow.dataset.scriptLeaderRefreshedAt = String(Date.now());
                mapWindow.dataset.scriptLeaderRefresh = 'pending';
                refreshActivePokemonForMap().then(changed => {
                    delete mapWindow.dataset.scriptLeaderRefresh;
                    if (changed) {
                        lastMapRenderSignature = '';
                        buildSimpleList();
                    }
                }).catch(() => { delete mapWindow.dataset.scriptLeaderRefresh; });
            }
            if (openedNow) {
                mapWindow.dataset.scriptLevelRefreshedAt = String(Date.now());
                mapWindow.dataset.scriptLevelRefresh = 'pending';
                loadTrainerLevel(true).then(() => {
                    delete mapWindow.dataset.scriptLevelRefresh;
                    lastMapRenderSignature = '';
                    buildSimpleList();
                });
            }
            if (cachedTrainerLevel === null && domTrainerLevel === null) {
                simpleContainer.innerHTML = '<div style="color:#718096;text-align:center;padding:20px;">Carregando nível do treinador…</div>';
                loadTrainerLevel().then(() => {
                    lastMapRenderSignature = '';
                    buildSimpleList();
                });
                return;
            }
            if (domTrainerLevel) cachedTrainerLevel = domTrainerLevel;
            const trainerLevel = cachedTrainerLevel || domTrainerLevel;
            const accessibleOption = document.querySelector('#filter-hunts-access option[value="accessible"]');
            if (accessibleOption) accessibleOption.textContent = `Somente acessíveis (seu nível: ${trainerLevel})`;

            let huntDataList = [];

            markers.forEach(marker => {
                const nameEl = marker.querySelector('.hunt-name');
                const lvlEl = marker.querySelector('.hunt-lvl');
                const iconDiv = marker.querySelector('.hunt-circle div[style*="background-image"]');

                const name = nameEl ? nameEl.textContent.trim() : 'Sem Nome';
                const lvlText = lvlEl ? lvlEl.textContent.trim() : 'Nv 1';
                const requiredLevel = parseInt(lvlText.replace(/\D/g, ''), 10) || 1;
                const city = isCityMarker(marker, name);
                const canAccess = city || trainerLevel >= requiredLevel;
                const isHere = marker.classList.contains('here');

                if (isHere && !city) saveLastHunt(name);

                const details = extractHuntDetailsFromJSON(name, marker);
                const defenderTypes = getDefenderTypes(name);
                const effectiveness = getOffensiveMultiplier(activePkmnTypes, defenderTypes);
                const xpEfficiency = (details.experience && effectiveness) ? details.experience / effectiveness : Infinity;
                const isCaught = globalCaughtPokemonNames.has(getCleanHuntName(name));

                huntDataList.push({
                    name, displayName: city ? getCityDisplayName(name) : name, city, lvlText, requiredLevel, canAccess, isHere, isCaught,
                    sellsFor: details.sellsFor,
                    numericPrice: details.numericPrice,
                    dropsHTML: details.dropsHTML,
                    experience: details.experience,
                    expText: details.expText,
                    effectiveness,
                    defenderTypes,
                    iconStyle: iconDiv ? (iconDiv.getAttribute('style') || '') : (city ? getCityIconStyle(name) : ''),
                    originalElement: marker,
                    xpEfficiency
                });
            });

            for (const markerData of new Set(globalHuntMarkerData.values())) {
                const name = getMarkerName(markerData);
                if (!name || !isCityMarker(markerData, name)
                    || huntDataList.some(entry => getCleanHuntName(entry.name) === getCleanHuntName(name))) continue;
                huntDataList.push({
                    name, displayName: getCityDisplayName(name), city: true, lvlText: '', requiredLevel: 1,
                    canAccess: true, isHere: false, isCaught: false, sellsFor: 'Indisponível', numericPrice: 0,
                    dropsHTML: '', experience: 0, expText: '', effectiveness: 1, defenderTypes: [],
                    iconStyle: getCityIconStyle(name), originalElement: null, xpEfficiency: Infinity
                });
            }

            [...new Set([...favorites, getLastHunt()].filter(Boolean))].forEach(name => {
                if (huntDataList.some(hunt => getCleanHuntName(hunt.name) === getCleanHuntName(name)) || isCityName(name)) return;
                const markerData = findMappedHunt(name);
                if (!markerData) return;
                const requiredLevel = Number(markerData.level ?? markerData.requiredLevel ?? markerData.minLevel ?? 1) || 1;
                const defenderTypes = getDefenderTypes(name);
                const effectiveness = getOffensiveMultiplier(activePkmnTypes, defenderTypes);
                const details = extractHuntDetailsFromJSON(name, null);
                huntDataList.push({
                    name, displayName: name, city: false, lvlText: `Nv ${requiredLevel}`, requiredLevel,
                    canAccess: trainerLevel >= requiredLevel, isHere: false,
                    isCaught: globalCaughtPokemonNames.has(getCleanHuntName(name)),
                    sellsFor: details.sellsFor, numericPrice: details.numericPrice, dropsHTML: details.dropsHTML,
                    experience: details.experience, expText: details.expText, effectiveness, defenderTypes,
                    iconStyle: '', originalElement: null,
                    xpEfficiency: details.experience && effectiveness ? details.experience / effectiveness : Infinity
                });
            });

            if (query) {
                huntDataList = huntDataList.filter(hunt =>
                    hunt.name.toLowerCase().includes(query) ||
                    String(hunt.dropsHTML || '').replace(/<[^>]+>/g, ' ').toLowerCase().includes(query)
                );
            }

                        const typeSelect = document.getElementById('filter-hunts-type');
            const savedType = getMapFilters().type || '';
            const availableTypes = [...new Set(
                huntDataList.filter(hunt => hunt.canAccess).flatMap(hunt => hunt.defenderTypes)
            )].sort();
            if (typeSelect) {
                // Preserva o valor selecionado atual (o usuário pode ter acabado de escolher).
                const currentType = typeSelect.value || savedType;
                typeSelect.replaceChildren(new Option('Todos os tipos', ''));
                availableTypes.forEach(type => typeSelect.add(new Option(type.toUpperCase(), type)));
                const finalValue = availableTypes.includes(currentType) ? currentType : '';
                typeSelect.value = finalValue;
                // Se o valor salvo não estiver mais disponível, limpa do storage
                // para evitar um filtro "fantasma".
                if (savedType && !availableTypes.includes(savedType)) {
                    setMapFilters({ ...getMapFilters(), type: '' });
                }
            }

            const selectedType = typeSelect?.value || '';
            const accessFilter = document.getElementById('filter-hunts-access')?.value || 'all';
            if (selectedType) {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess && hunt.defenderTypes.includes(selectedType));
            }
            if (accessFilter === 'accessible') {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess);
            } else if (accessFilter === 'favorites') {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess && favorites.includes(hunt.name));
            } else if (accessFilter === 'advantage') {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess && hunt.effectiveness > 1);
            } else if (accessFilter === 'neutral') {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess && hunt.effectiveness === 1);
            } else if (accessFilter === 'disadvantage') {
                huntDataList = huntDataList.filter(hunt => hunt.canAccess && hunt.effectiveness < 1);
            } else if (accessFilter === 'locked') {
                huntDataList = huntDataList.filter(hunt => !hunt.canAccess);
            } else if (accessFilter === 'not_favorites') {
                huntDataList = huntDataList.filter(hunt => !favorites.includes(hunt.name));
            }

            const savedLevelFilters = getMapFilters();
            const minLevel = savedLevelFilters.levelMin === '' ? null : Number(savedLevelFilters.levelMin);
            const maxLevel = savedLevelFilters.levelMax === '' ? null : Number(savedLevelFilters.levelMax);
            if (minLevel !== null && Number.isFinite(minLevel)) {
                huntDataList = huntDataList.filter(hunt => hunt.city || hunt.requiredLevel >= minLevel);
            }
            if (maxLevel !== null && Number.isFinite(maxLevel)) {
                huntDataList = huntDataList.filter(hunt => hunt.city || hunt.requiredLevel <= maxLevel);
            }

            const capturedFilter = document.getElementById('custom-hunts-capture-bar')?.dataset.active || '';
            if (capturedFilter === 'yes') {
                huntDataList = huntDataList.filter(hunt => hunt.city || hunt.isCaught);
            } else if (capturedFilter === 'no') {
                huntDataList = huntDataList.filter(hunt => hunt.city || !hunt.isCaught);
            }
            huntDataList = huntDataList.filter(hunt => viewMode === 'cities' ? hunt.city : !hunt.city);

            const sortVal = document.getElementById('sort-hunts-select')?.value || '';
            huntDataList.sort((a, b) => {
                const aFav = favorites.includes(a.name);
                const bFav = favorites.includes(b.name);
                if (aFav && !bFav) return -1;
                if (!aFav && bFav) return 1;

                if (sortVal === 'price_desc') return b.numericPrice - a.numericPrice;
                if (sortVal === 'price_asc') return a.numericPrice - b.numericPrice;
                if (sortVal === 'eff_desc') {
                    if (b.effectiveness !== a.effectiveness) return b.effectiveness - a.effectiveness;
                    const lvlA = parseInt(a.lvlText.replace(/\D/g, '')) || 0;
                    const lvlB = parseInt(b.lvlText.replace(/\D/g, '')) || 0;
                    return lvlB - lvlA;
                }
                if (sortVal === 'xp_desc') {
                    if (b.experience !== a.experience) return b.experience - a.experience;
                    return b.effectiveness - a.effectiveness;
                }
                return a.name.localeCompare(b.name);
            });

            const lastHunt = getLastHunt();
            if (viewMode === 'hunts' && lastHunt) {
                const lastIndex = huntDataList.findIndex(hunt => getCleanHuntName(hunt.name) === getCleanHuntName(lastHunt));
                if (lastIndex > 0) huntDataList.unshift(huntDataList.splice(lastIndex, 1)[0]);
            }

            const renderSignature = JSON.stringify({
                query, sortVal, selectedType, accessFilter, capturedFilter, trainerLevel, favorites, viewMode, lastHunt,
                rows: huntDataList.map(hunt => [
                    hunt.name, hunt.lvlText, hunt.canAccess, hunt.isHere, hunt.isCaught,
                    hunt.numericPrice, hunt.experience, hunt.effectiveness
                ])
            });
            if (renderSignature === lastMapRenderSignature && simpleContainer.childElementCount) return;
            lastMapRenderSignature = renderSignature;
            simpleContainer.innerHTML = '';

            if (huntDataList.length === 0) {
                simpleContainer.innerHTML = `<div style="color: #718096; text-align: center; padding: 20px;">Nenhuma hunt encontrada.</div>`;
                isRendering = false;
                return;
            }

            const dropMode = getDropMode();

            huntDataList.forEach(hunt => {
                const isFav = favorites.includes(hunt.name);
                const isLast = viewMode === 'hunts' && getCleanHuntName(hunt.name) === getCleanHuntName(lastHunt);
                const row = document.createElement('div');
                row.style = `
                    display: flex; align-items: center; justify-content: space-between;
                    padding: 10px 14px; margin-bottom: 8px;
                    background: ${!hunt.canAccess ? '#25191d' : (hunt.isHere ? '#163126' : (isFav ? '#282116' : '#14222d'))};
                    border-left: 4px solid ${!hunt.canAccess ? '#e05252' : (hunt.isHere ? '#4caf50' : (isFav ? '#f6c453' : '#273f52'))};
                    border-radius: 4px; color: #e2e8f0; font-size: 14px;
                    cursor: ${hunt.canAccess ? 'pointer' : 'not-allowed'}; position: relative;
                    opacity: ${hunt.canAccess ? '1' : '.72'};
                `;

                const spriteContainer = document.createElement('div');
                spriteContainer.style = `
                    width: 42px; height: 42px; min-width: 42px; overflow: hidden; display: flex;
                    align-items: center; justify-content: center; background: #1c3040; border-radius: 50%; margin-right: 14px;
                `;

                if (hunt.city) {
                    const badge = document.createElement('span');
                    badge.textContent = /cerulean/i.test(hunt.name) ? '💧' : /pewter|lavender/i.test(hunt.name) ? '🪨' : /viridian/i.test(hunt.name) ? '🌿' : '🎰';
                    badge.style.cssText = 'font-size:25px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));';
                    spriteContainer.appendChild(badge);
                } else if (hunt.iconStyle) {
                    const sprite = document.createElement('div');
                    sprite.style = hunt.iconStyle;
                    spriteContainer.appendChild(sprite);
                } else {
                    const spriteUrl = getPokemonIconUrlByName(hunt.name);
                    if (spriteUrl) {
                        const sprite = document.createElement('img');
                        sprite.src = spriteUrl;
                        sprite.alt = hunt.displayName;
                        sprite.style = 'width:38px;height:38px;object-fit:contain;image-rendering:pixelated;';
                        sprite.onerror = () => sprite.remove();
                        spriteContainer.appendChild(sprite);
                    }
                }

                let bottomInfoHTML = '';
                if (hunt.sellsFor !== 'Indisponível' || hunt.expText) {
                    let priceHTML = '';
                    if (hunt.sellsFor === 'Não pode ser vendido') priceHTML = `<span>${hunt.sellsFor}</span>`;
                    else if (hunt.sellsFor !== 'Indisponível') priceHTML = `<span>Valor: ${hunt.sellsFor}</span>`;

                    bottomInfoHTML = `
                        <div style="font-size: 12px; color: #48bb78; margin-top: 3px; font-weight: 500; display: flex; gap: 10px;">
                            ${priceHTML}
                            ${hunt.expText ? `<span style="color: #ed8936;">${hunt.expText}</span>` : ''}
                        </div>
                    `;
                }

                const typeBadgesHTML = hunt.defenderTypes.map(t =>
                    `<span class="script-type-badge script-type-${t}" style="font-size:10px;padding:2px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.5px;">${t}</span>`
                ).join(' ');

                const infoDiv = document.createElement('div');
                infoDiv.style = 'flex-grow: 1; margin-right: 12px;';
                infoDiv.innerHTML = `
                    <div style="font-weight: bold; color: ${isFav ? '#3182ce' : '#fff'}; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                        ${hunt.city ? '' : `<span class="hunt-capture-badge${hunt.isCaught ? '' : ' not-caught'}" title="${hunt.isCaught ? 'Já capturado' : 'Ainda não capturado'}"></span>`}
                        ${isLast ? '<span style="color:#f6c453">Última hunt:</span>' : ''} ${hunt.displayName}
                        ${hunt.city ? '' : `<span style="font-size: 11px; background: #243b4d; padding: 2px 6px; border-radius: 4px; color: #cbd5e0;">
                            ${hunt.lvlText}
                        </span>`}
                        ${hunt.city ? '' : `<span class="script-effectiveness ${hunt.effectiveness > 1 ? 'great' : hunt.effectiveness < 1 ? 'bad' : 'neutral'}">
                            ${hunt.effectiveness > 1 ? `⚡ ${hunt.effectiveness}x` : `${hunt.effectiveness}x`}
                        </span>`}
                        ${hunt.city ? '' : typeBadgesHTML}
                        ${hunt.isHere ? '<span style="font-size: 11px; color: #4caf50; font-weight: bold;">[Aqui]</span>' : ''}
                        ${!hunt.canAccess ? `<span style="font-size:11px;color:#ff8b8b;background:#3b2026;border:1px solid #71313c;padding:2px 6px;border-radius:4px;">🔒 Requer nível ${hunt.requiredLevel}</span>` : ''}
                    </div>
                    ${hunt.city ? '' : bottomInfoHTML}
                `;

                if (dropMode === 'hover' && hunt.dropsHTML) {
                    row.addEventListener('mouseenter', (e) => showDropTooltip(e, hunt.dropsHTML));
                    row.addEventListener('mouseleave', hideDropTooltip);
                }

                row.addEventListener('click', (e) => {
                    if (e.target.closest('button')) return;
                    hideDropTooltip();
                    if (!hunt.canAccess) {
                        showScriptNotice(`Esta hunt exige nível ${hunt.requiredLevel}. Seu nível atual é ${trainerLevel}.`, {
                            title: 'Hunt bloqueada'
                        });
                        return;
                    }
                    saveLastHunt(hunt.name);
                    teleportToTarget(hunt.name);
                });

                const actionContainer = document.createElement('div');
                actionContainer.style = 'display: flex; align-items: center;';

                if (dropMode === 'icon' && hunt.dropsHTML) {
                    const iconBtn = document.createElement('button');
                    iconBtn.type = 'button';
                    iconBtn.className = 'drop-icon-btn';
                    iconBtn.innerHTML = '?';
                    iconBtn.addEventListener('mouseenter', (e) => showDropTooltip(e, hunt.dropsHTML));
                    iconBtn.addEventListener('mouseleave', hideDropTooltip);
                    actionContainer.appendChild(iconBtn);
                }

                const favBtn = document.createElement('button');
                favBtn.type = 'button';
                favBtn.innerHTML = isFav ? '★' : '☆';
                favBtn.style = `
                    background: none; border: none; color: ${isFav ? '#f6c453' : '#4a5568'};
                    font-size: 20px; cursor: pointer; padding: 4px 8px; outline: none;
                `;
                favBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleFavorite(hunt.name);
                });

                actionContainer.appendChild(favBtn);

                row.appendChild(spriteContainer);
                row.appendChild(infoDiv);
                row.appendChild(actionContainer);
                simpleContainer.appendChild(row);
            });

        } catch (e) {
            console.error("Erro no Simplificador de Mapa: ", e);
        } finally {
            isRendering = false;
        }
    }

    let activeTooltip = null;
    function showDropTooltip(e, dropsHTML) {
        hideDropTooltip();
        activeTooltip = document.createElement('div');
        activeTooltip.className = 'hunt-drop-tooltip';
        activeTooltip.innerHTML = `<div style="font-weight:bold; color:#48bb78; margin-bottom:8px; border-bottom:1px solid #1a2d3a; padding-bottom:4px; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Drops da Hunt:</div><div>${dropsHTML}</div>`;
        document.body.appendChild(activeTooltip);

        const rect = e.target.getBoundingClientRect();
        activeTooltip.style.top = `${rect.bottom + window.scrollY + 6}px`;
        activeTooltip.style.left = `${rect.left + window.scrollX}px`;
    }

    function hideDropTooltip() {
        if (activeTooltip) {
            activeTooltip.remove();
            activeTooltip = null;
        }
    }

    let renderTimeout = null;

    function showSellConfirm(itemNames, callback) {
        if (!itemNames || itemNames.length === 0) return callback(true);

        const backdrop = document.createElement('div');
        backdrop.className = 'sell-confirm-backdrop';
        backdrop.innerHTML = `
            <div class="sell-confirm-modal">
                <div class="sell-confirm-title">⚠️ Confirmar Venda</div>
                <div class="sell-confirm-body">
                    <p>Você está prestes a vender os seguintes itens de alto valor:</p>
                    <div class="sell-confirm-items">
                        ${itemNames.map(n => `<div>• ${escapeHTML(n)}</div>`).join('')}
                    </div>
                    <div class="sell-confirm-footer">
                        <button class="sell-confirm-btn yes" type="button">✅ Confirmar Venda</button>
                        <button class="sell-confirm-btn no" type="button">❌ Cancelar</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        backdrop.querySelector('.yes').addEventListener('click', () => {
            backdrop.remove();
            callback(true);
        });
        backdrop.querySelector('.no').addEventListener('click', () => {
            backdrop.remove();
            callback(false);
        });
    }

    function getPokemonRarity(row) {
        const span = row.querySelector('.mk-meta span');
        if (!span) return null;
        return span.textContent.trim().toLowerCase();
    }

    function getGameTokens() {
        try {
            return JSON.parse(sessionStorage.getItem('pokeweb:tokens') || 'null');
        } catch {
            return null;
        }
    }

    async function refreshGameAccessToken() {
        const tokens = getGameTokens();
        if (!tokens?.refreshToken) return null;
        const response = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: tokens.refreshToken })
        });
        if (!response.ok) return null;
        const refreshed = await response.json();
        if (!refreshed?.accessToken) return null;
        sessionStorage.setItem('pokeweb:tokens', JSON.stringify(refreshed));
        return refreshed.accessToken;
    }

    async function gameApiRequest(url, options = {}) {
        const send = accessToken => fetch(url, {
            ...options,
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                ...(options.headers || {})
            }
        });

        let response = await send(getGameTokens()?.accessToken);
        if (response.status === 401) {
            const refreshedToken = await refreshGameAccessToken();
            if (refreshedToken) response = await send(refreshedToken);
        }

        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result?.message || `HTTP ${response.status}`);
        return result;
    }

    async function readSellableInventoryFromDOM() {
        if (itemDataLoadPromise) await itemDataLoadPromise;
        const findVisibleInventory = () => Array.from(document.querySelectorAll('.inv-window')).find(windowElement => {
            const style = getComputedStyle(windowElement);
            const rect = windowElement.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        }) || null;

        let inventoryWindow = findVisibleInventory();
        const openedByScript = !inventoryWindow;
        if (!inventoryWindow) {
            document.querySelector('[data-guide="dock-inventory"]')?.click();
            for (let attempt = 0; attempt < 15 && !inventoryWindow; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                inventoryWindow = findVisibleInventory();
            }
        }
        if (!inventoryWindow) throw new Error('Inventário não abriu.');

        const payload = await fetch(ITEMS_JSON_URL).then(response => response.json());
        const items = Array.isArray(payload) ? payload : (payload.items || []);
        const catalogById = new Map(items.map(item => [String(item.id), item]));

        const entries = Array.from(inventoryWindow.querySelectorAll('.inv-slot[data-guide^="inv-item-"]'))
            .map(slot => {
                const itemId = slot.dataset.guide.replace('inv-item-', '');
                const name = slot.querySelector('.inv-ico')?.alt?.trim() || '';
                const qty = parseInt(slot.querySelector('.inv-qty')?.textContent, 10) || 0;
                const catalogItem = catalogById.get(String(itemId));
                return {
                    itemId,
                    name,
                    qty,
                    category: String(catalogItem?.category || '').toLowerCase(),
                    npcPrice: parseGameNumber(catalogItem?.npcPrice)
                };
            })
            .filter(item => item.itemId && item.name && item.qty > 0 && item.npcPrice > 0)
            .filter(item => !['heal', 'revive', 'stone'].includes(item.category));

        if (openedByScript) inventoryWindow.querySelector('.cfg-x')?.click();
        return entries;
    }

    function sellItemsThroughShop(items) {
        return gameApiRequest('/api/game/shop/sell', {
            method: 'POST',
            body: JSON.stringify({ items })
        });
    }

    function showPurchaseConfirm({ name, quantity, unitPrice, currentGold, currentBalance, currency = 'GOLD' }, callback) {
        const total = quantity * unitPrice;
        const balance = Number(currentBalance ?? currentGold ?? 0);
        const currencyIcon = String(currency).toUpperCase() === 'DIAMONDS' ? '💎' : '💲';
        const locale = getGameLanguage() === 'pt' ? 'pt-BR' : 'en-US';
        const backdrop = document.createElement('div');
        backdrop.className = 'sell-confirm-backdrop';
        backdrop.innerHTML = `
            <div class="sell-confirm-modal">
                <div class="sell-confirm-title">🛒 Confirmar compra</div>
                <div class="sell-confirm-body">
                    <p><b>${quantity.toLocaleString(locale)}× ${escapeHTML(name)}</b></p>
                    <div class="sell-confirm-items">
                        <div>Preço unitário: ${currencyIcon}${unitPrice.toLocaleString(locale)}</div>
                        <div>Total: ${currencyIcon}${total.toLocaleString(locale)}</div>
                        <div>Saldo após compra: ${currencyIcon}${Math.max(0, balance - total).toLocaleString(locale)}</div>
                    </div>
                    <div class="sell-confirm-footer">
                        <button class="sell-confirm-btn yes" type="button" ${total > balance ? 'disabled' : ''}>Confirmar</button>
                        <button class="sell-confirm-btn no" type="button">Cancelar</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        backdrop.querySelector('.yes').addEventListener('click', () => {
            backdrop.remove();
            callback(true);
        });
        backdrop.querySelector('.no').addEventListener('click', () => {
            backdrop.remove();
            callback(false);
        });
    }

    function showScriptNotice(message, { title = 'Aviso', isError = false } = {}) {
        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.className = 'sell-confirm-backdrop script-notice-backdrop';
            backdrop.innerHTML = `
                <div class="sell-confirm-modal" style="width:min(420px,92vw);">
                    <div class="sell-confirm-title">${isError ? '⚠️' : 'ℹ️'} ${escapeHTML(title)}</div>
                    <div class="sell-confirm-body">
                        <p style="margin:0 0 14px;color:${isError ? '#feb2b2' : '#e2e8f0'};">${escapeHTML(message)}</p>
                        <div class="sell-confirm-footer">
                            <button class="sell-confirm-btn yes script-notice-ok" type="button">OK</button>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(backdrop);
            backdrop.querySelector('.script-notice-ok').addEventListener('click', () => {
                backdrop.remove();
                resolve();
            });
        });
    }

    function showScriptConfirm(message, { title = 'Confirmar', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar' } = {}) {
        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.className = 'sell-confirm-backdrop script-confirm-backdrop';
            backdrop.innerHTML = `
                <div class="sell-confirm-modal" style="width:min(440px,92vw);">
                    <div class="sell-confirm-title">❔ ${escapeHTML(title)}</div>
                    <div class="sell-confirm-body">
                        <p style="margin:0 0 14px;color:#e2e8f0;">${escapeHTML(message)}</p>
                        <div class="sell-confirm-footer">
                            <button class="sell-confirm-btn yes script-confirm-yes" type="button">${escapeHTML(confirmLabel)}</button>
                            <button class="sell-confirm-btn no script-confirm-no" type="button">${escapeHTML(cancelLabel)}</button>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(backdrop);
            backdrop.querySelector('.script-confirm-yes').addEventListener('click', () => {
                backdrop.remove();
                resolve(true);
            });
            backdrop.querySelector('.script-confirm-no').addEventListener('click', () => {
                backdrop.remove();
                resolve(false);
            });
        });
    }

    function showScriptQuantityPrompt(message, maximum) {
        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.className = 'sell-confirm-backdrop script-quantity-backdrop';
            backdrop.innerHTML = `<div class="sell-confirm-modal" style="width:min(380px,92vw);">
                <div class="sell-confirm-title" style="padding:13px 16px;">📦 Quantidade</div><div class="sell-confirm-body" style="display:grid;gap:12px;padding:16px;">
                <label style="display:grid;gap:7px;color:#aebdca;font-size:13px;"><span>${escapeHTML(message)}</span>
                <input class="script-quantity-input" type="number" min="1" max="${maximum}" value="${maximum}" style="width:100%;height:40px;box-sizing:border-box;background:#0c161f;color:#f1f5f9;border:1px solid #9f7b35;border-radius:7px;padding:8px 11px;font:700 14px var(--piw-game-font);outline:none;"></label>
                <div class="sell-confirm-footer" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0;padding:0;"><button class="sell-confirm-btn yes" type="button" style="width:100%;min-height:38px;">Confirmar</button><button class="sell-confirm-btn no" type="button" style="width:100%;min-height:38px;">Cancelar</button></div>
                </div></div>`;
            document.body.appendChild(backdrop);
            const finish = value => { backdrop.remove(); resolve(value); };
            backdrop.querySelector('.yes').addEventListener('click', () => {
                const value = Math.floor(Number(backdrop.querySelector('input').value));
                finish(Number.isFinite(value) && value >= 1 ? Math.min(maximum, value) : null);
            });
            backdrop.querySelector('.no').addEventListener('click', () => finish(null));
            backdrop.querySelector('input').focus();
        });
    }

    function showWindowMessage(windowElement, message, isError = false) {
        let messageElement = windowElement.querySelector('.script-window-message');
        if (!messageElement) {
            messageElement = document.createElement('div');
            messageElement.className = 'script-window-message';
            messageElement.style.cssText = 'padding:7px 12px;text-align:center;font-size:12px;font-weight:bold;';
            windowElement.appendChild(messageElement);
        }
        messageElement.style.color = isError ? '#f56565' : '#48bb78';
        messageElement.textContent = message;
        clearTimeout(messageElement._hideTimer);
        messageElement._hideTimer = setTimeout(() => messageElement.remove(), 3500);
    }

    async function showPortableDepot() {
        if (getSidebarLocation() === 'hunt') {
            showScriptNotice('O Depot não está disponível durante hunts.');
            return;
        }
        document.querySelector('.portable-depot-backdrop')?.remove();

        const backdrop = document.createElement('div');
        backdrop.className = 'sell-confirm-backdrop portable-depot-backdrop';
        backdrop.innerHTML = `
            <div class="sell-confirm-modal" style="width:780px;max-width:95vw;">
                <div class="sell-confirm-title">
                    <span>📦 Depot</span>
                    <button class="mk-bulk-btn depot-tab active" data-tab="items" type="button" style="margin-left:auto;">Itens</button>
                    <button class="mk-bulk-btn depot-tab" data-tab="pokemon" type="button">Pokémon</button>
                    <span class="portable-depot-family-tabs"></span>
                    <button class="portable-depot-close" type="button" style="background:none;border:0;color:#a0aec0;font-size:20px;cursor:pointer;">×</button>
                </div>
                <div class="sell-confirm-body">
                    <div class="portable-depot-status" style="color:#a0aec0;text-align:center;padding:16px;">Carregando Depot...</div>
                    <div class="portable-depot-content"></div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const close = () => backdrop.remove();
        backdrop.querySelector('.portable-depot-close').addEventListener('click', close);
        backdrop.addEventListener('click', event => {
            if (event.target === backdrop) close();
        });

        const status = backdrop.querySelector('.portable-depot-status');
        const content = backdrop.querySelector('.portable-depot-content');
        const familyTabs = backdrop.querySelector('.portable-depot-family-tabs');
        let activeTab = 'items';
        let depotData = null;
        let pokes = [];
        let inventory = [];
        let familyData = null;
        let busy = false;
        const depotPokeFilters = { name: '', ivMin: '', ivMax: '', qualityMin: '', qualityMax: '' };
        const familyPokeFilters = { name: '', ivMin: '', ivMax: '', qualityMin: '', qualityMax: '' };
        const depotItemFilters = { name: '' };
        const familyItemFilters = { name: '' };

        const familyAction = async payload => {
            if (busy || !familyData?.family) return;
            const family = familyData.family;
            if (family.frozen || family.movesUsed >= family.movesCap) {
                showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), family.frozen
                    ? 'O depósito da família está congelado.'
                    : 'O limite diário de movimentos foi atingido.', true);
                return;
            }
            busy = true;
            try {
                latestFamily = null;
                const previousFamilyData = familyData;
                const response = await requestGameEvent('family', { type: 'family-action', ...payload }, null, 5000);
                if (!response?.family) {
                    familyData = previousFamilyData;
                    throw new Error(response?.message || response?.error || 'O servidor recusou esta transferência.');
                }
                familyData = response;
                if (payload.action === 'item') {
                    latestInventory = null;
                    inventory = await requestFreshGameEvent('inventory', 'inv-get', { timeoutMs: 2500, attempts: 2 });
                } else {
                    latestPokemon = null;
                    pokes = await requestGameEvent('pokes', 'pokes-get', null, 2500);
                }
                render();
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message || 'Não foi possível mover.', true);
                const refreshed = await requestFreshGameEvent('family', 'family-get', { timeoutMs: 3500, attempts: 1 }).catch(() => null);
                if (refreshed?.family) familyData = refreshed;
                render();
            } finally {
                busy = false;
            }
        };

        const makeFamilyColumn = (title, entries, direction, kind) => {
            const column = document.createElement('section');
            column.style.cssText = 'flex:1;min-width:260px;background:#0d1822;border:1px solid #243545;border-radius:10px;padding:10px;max-height:52vh;overflow:auto;';
            const heading = document.createElement('div');
            heading.style.cssText = 'font-weight:800;color:#e7edf4;margin:2px 4px 10px;';
            heading.textContent = `${title} (${entries.length})`;
            column.appendChild(heading);
            if (!entries.length) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color:#7f91a3;text-align:center;padding:28px 8px;';
                empty.textContent = 'Nenhum conteúdo disponível.';
                column.appendChild(empty);
                return column;
            }
            entries.forEach(entry => {
                const row = document.createElement('button');
                row.type = 'button';
                row.style.cssText = 'display:flex;width:100%;align-items:center;gap:9px;background:#13222f;color:#e7edf4;border:1px solid #263b4c;border-radius:8px;padding:8px;margin:0 0 7px;cursor:pointer;text-align:left;';
                const icon = document.createElement('img');
                icon.src = kind === 'item' ? normalizeGameItemIcon(entry.icon) : getPokemonIconUrl(entry.speciesId);
                icon.alt = entry.name || '';
                icon.style.cssText = `width:34px;height:34px;object-fit:contain;${kind === 'pokemon' ? 'image-rendering:pixelated;' : ''}flex:none;`;
                icon.onerror = () => { icon.style.visibility = 'hidden'; };
                const label = document.createElement('span');
                label.style.cssText = 'min-width:0;flex:1;font-weight:700;';
                label.textContent = kind === 'item'
                    ? `${entry.name || `Item #${entry.itemId}`} · ${Number(entry.quantity || 0).toLocaleString('pt-BR')}`
                    : `${entry.name || entry.speciesId} · Nv ${Number(entry.level || 0)} · IV ${Number(entry.ivTotal || 0)} · ${formatPokemonQualityWithPotential(entry.quality, entry.ivTotal)}${direction === 'deposit' ? ` · ${entry.team ? 'Equipe' : 'Box'}` : ''}`;
                if (kind === 'pokemon') {
                    const rarity = getPokemonQualityInfo(entry.quality);
                    if (rarity) label.style.color = rarity.color;
                }
                const action = document.createElement('span');
                action.style.cssText = 'color:#64c8ff;font-size:12px;font-weight:800;';
                action.textContent = direction === 'deposit' ? 'Depositar →' : '← Retirar';
                row.append(icon, label);
                if (kind === 'pokemon') {
                    const lock = document.createElement('span');
                    lock.textContent = isNativeLocked(entry) ? '🔒' : '🔓';
                    lock.title = 'Proteger/desproteger Pokémon';
                    lock.style.cssText = 'padding:5px;font-size:16px;';
                    lock.addEventListener('click', async event => {
                        event.preventDefault(); event.stopPropagation();
                        try { await toggleNativeLock('pokemon', entry); render(); }
                        catch (error) { showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message, true); }
                    });
                    row.appendChild(lock);
                } else {
                    const reason = getItemProtectionReason(entry);
                    const lock = document.createElement('span');
                    lock.textContent = reason ? '🔒' : '🔓';
                    lock.title = reason ? `Bloqueado por: ${reason}. Clique para desbloquear.` : 'Clique para bloquear pelo cadeado nativo do Mark';
                    lock.setAttribute('role', 'button'); lock.tabIndex = 0;
                    lock.style.cssText = 'padding:5px;font-size:16px;cursor:pointer;';
                    lock.addEventListener('click', async event => {
                        event.preventDefault(); event.stopPropagation();
                        try { await togglePortableItemProtection(entry); render(); }
                        catch (error) { showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message, true); }
                    });
                    row.appendChild(lock);
                }
                row.appendChild(action);
                row.addEventListener('click', async () => {
                    if (kind === 'item') {
                        const protectionReason = getItemProtectionReason(entry);
                        if (protectionReason) {
                            showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), `❌ Este item está TRAVADO (${protectionReason}). Destrave-o para depositá-lo.`, true);
                            return;
                        }
                        const available = Math.max(1, Math.floor(Number(entry.quantity) || 1));
                        const quantity = await showScriptQuantityPrompt(`Quantidade de ${entry.name || `Item #${entry.itemId}`}:`, available);
                        if (!quantity) return;
                        familyAction({ action: 'item', dir: direction, itemId: entry.itemId ?? entry.id, quantity });
                    } else {
                        if (isNativeLocked(entry)) {
                            showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), 'Desbloqueie este Pokémon antes de transferi-lo.', true);
                            return;
                        }
                        const confirmed = await showScriptConfirm(
                            `${direction === 'deposit' ? 'Depositar' : 'Retirar'} ${entry.name || 'este Pokémon'} no depósito da família?`,
                            { title: 'Depósito da família' }
                        );
                        if (confirmed) familyAction({ action: 'poke', dir: direction, capturedId: entry.id });
                    }
                });
                column.appendChild(row);
            });
            return column;
        };

        const renderFamilyHeader = () => {
            const family = familyData?.family;
            if (!family) return;
            const header = document.createElement('div');
            header.style.cssText = 'flex-basis:100%;display:flex;justify-content:space-between;gap:12px;padding:9px 12px;background:#13222f;border:1px solid #263b4c;border-radius:8px;color:#cbd5e0;font-size:12px;';
            header.innerHTML = `<strong>${escapeHTML(family.name)}</strong><span>${Number(family.movesUsed || 0)}/${Number(family.movesCap || 0)} movimentos hoje${family.frozen ? ' · congelado' : ''}</span>`;
            content.appendChild(header);
        };

        const filterDepotPokemon = (entries, filters) => entries.filter(entry => {
            const name = String(entry.name || '').toLocaleLowerCase();
            const query = filters.name.trim().toLocaleLowerCase();
            const iv = Number(entry.ivTotal || 0);
            const quality = Number(entry.quality || 0);
            const decimal = value => Number(String(value).replace(',', '.'));
            if (query && !name.includes(query)) return false;
            if (filters.ivMin !== '' && iv < Number(filters.ivMin)) return false;
            if (filters.ivMax !== '' && iv > Number(filters.ivMax)) return false;
            if (filters.qualityMin !== '' && quality < decimal(filters.qualityMin)) return false;
            if (filters.qualityMax !== '' && quality > decimal(filters.qualityMax)) return false;
            return true;
        });

        const normalizeDepotItemSearch = value => String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase()
            .trim();

        const filterDepotItems = (entries, filters) => {
            const query = normalizeDepotItemSearch(filters.name);
            if (!query) return entries;
            return entries.filter(entry => normalizeDepotItemSearch(
                entry.name || `Item #${entry.itemId ?? entry.id ?? ''}`
            ).includes(query));
        };

        const makeDepotItemFilters = (filters, placeholder) => {
            const controls = document.createElement('div');
            controls.className = 'portable-depot-item-filters';
            controls.innerHTML = `
                <input type="search" class="portable-depot-item-search" placeholder="${escapeHTML(placeholder)}" autocomplete="off">
                <button type="button" class="portable-depot-clear-filters">Limpar</button>`;
            const input = controls.querySelector('.portable-depot-item-search');
            input.value = filters.name;
            input.addEventListener('input', () => {
                filters.name = input.value;
                render();
                const replacement = content.querySelector('.portable-depot-item-search');
                replacement?.focus();
                replacement?.setSelectionRange?.(replacement.value.length, replacement.value.length);
            });
            controls.querySelector('.portable-depot-clear-filters').addEventListener('click', () => {
                filters.name = '';
                render();
                content.querySelector('.portable-depot-item-search')?.focus();
            });
            return controls;
        };

        const makeDepotPokemonFilters = filters => {
            const controls = document.createElement('div');
            controls.className = 'portable-depot-poke-filters';
            controls.innerHTML = `
                <input type="text" data-filter="name" placeholder="Buscar Pokémon pelo nome">
                <input type="number" data-filter="ivMin" min="0" max="192" placeholder="IV mín.">
                <input type="number" data-filter="ivMax" min="0" max="192" placeholder="IV máx.">
                <input type="text" inputmode="decimal" data-filter="qualityMin" placeholder="Qual. mín. (0,00)">
                <input type="text" inputmode="decimal" data-filter="qualityMax" placeholder="Qual. máx. (0,00)">
                <button type="button" class="portable-depot-clear-filters">Limpar</button>`;
            controls.querySelectorAll('[data-filter]').forEach(input => {
                input.value = filters[input.dataset.filter];
                input.addEventListener('input', () => {
                    filters[input.dataset.filter] = input.value;
                    render();
                    const replacement = content.querySelector(`[data-filter="${input.dataset.filter}"]`);
                    replacement?.focus();
                    replacement?.setSelectionRange?.(replacement.value.length, replacement.value.length);
                });
            });
            controls.querySelector('.portable-depot-clear-filters').addEventListener('click', () => {
                Object.keys(filters).forEach(key => { filters[key] = ''; });
                render();
            });
            return controls;
        };

        const makeColumn = (title, entries, direction, emptyText, isPokemon = false) => {
            const column = document.createElement('section');
            column.style.cssText = 'flex:1;min-width:260px;background:#0d1822;border:1px solid #243545;border-radius:10px;padding:10px;max-height:58vh;overflow:auto;';
            const heading = document.createElement('div');
            heading.style.cssText = 'font-weight:800;color:#e7edf4;margin:2px 4px 10px;';
            heading.textContent = `${title} (${entries.length})`;
            column.appendChild(heading);

            if (!entries.length) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color:#7f91a3;text-align:center;padding:28px 8px;';
                empty.textContent = emptyText;
                column.appendChild(empty);
                return column;
            }

            entries.forEach(entry => {
                const row = document.createElement('button');
                row.type = 'button';
                row.style.cssText = 'display:flex;width:100%;align-items:center;gap:9px;background:#13222f;color:#e7edf4;border:1px solid #263b4c;border-radius:8px;padding:8px;margin:0 0 7px;cursor:pointer;text-align:left;';
                const image = document.createElement('img');
                if (isPokemon) {
                    image.src = getPokemonIconUrl(entry.speciesId);
                    image.alt = entry.name || '';
                    image.style.cssText = 'width:34px;height:34px;object-fit:contain;image-rendering:pixelated;flex:none;';
                    image.onerror = () => { image.style.visibility = 'hidden'; };
                } else {
                    image.src = normalizeGameItemIcon(entry.icon);
                    image.alt = entry.name || '';
                    image.style.cssText = 'width:34px;height:34px;object-fit:contain;flex:none;';
                    image.onerror = () => { image.style.visibility = 'hidden'; };
                }
                const label = document.createElement('span');
                label.style.cssText = 'min-width:0;flex:1;font-weight:700;';
                label.textContent = isPokemon
                    ? `${entry.name || entry.pokeId} · Nv ${Number(entry.level || 0)} · IV ${Number(entry.ivTotal || 0)} · ${formatPokemonQualityWithPotential(entry.quality, entry.ivTotal)}`
                    : `${entry.name} · ${Number(entry.quantity || 0).toLocaleString('pt-BR')}`;
                if (isPokemon) {
                    const rarity = getPokemonQualityInfo(entry.quality);
                    if (rarity) label.style.color = rarity.color;
                }
                const action = document.createElement('span');
                action.style.cssText = 'color:#64c8ff;font-size:12px;font-weight:800;';
                action.textContent = direction === 'store' ? 'Guardar →' : '← Retirar';
                row.append(image, label);
                if (isPokemon) {
                    const lock = document.createElement('span');
                    lock.textContent = isNativeLocked(entry) ? '🔒' : '🔓';
                    lock.title = 'Proteger/desproteger Pokémon';
                    lock.style.cssText = 'padding:5px;font-size:16px;';
                    lock.addEventListener('click', async event => {
                        event.preventDefault(); event.stopPropagation();
                        try { await toggleNativeLock('pokemon', entry); render(); }
                        catch (error) { showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message, true); }
                    });
                    row.appendChild(lock);
                } else {
                    const reason = getItemProtectionReason(entry);
                    const lock = document.createElement('span');
                    lock.textContent = reason ? '🔒' : '🔓';
                    lock.title = reason ? `Bloqueado por: ${reason}. Clique para desbloquear.` : 'Clique para bloquear pelo cadeado nativo do Mark';
                    lock.setAttribute('role', 'button'); lock.tabIndex = 0;
                    lock.style.cssText = 'padding:5px;font-size:16px;cursor:pointer;';
                    lock.addEventListener('click', async event => {
                        event.preventDefault(); event.stopPropagation();
                        try { await togglePortableItemProtection(entry); render(); }
                        catch (error) { showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message, true); }
                    });
                    row.appendChild(lock);
                }
                row.appendChild(action);
                row.addEventListener('click', async () => {
                    if (busy) return;
                    busy = true;
                    row.disabled = true;
                    try {
                        if (isPokemon) {
                            sendGameMessage({ type: direction === 'store' ? 'poke-store' : 'poke-withdraw', pokeId: entry.id });
                            latestPokemon = null;
                            await new Promise(resolve => setTimeout(resolve, 350));
                            pokes = await requestGameEvent('pokes', 'pokes-get', latestPokemon);
                        } else {
                            const protectionReason = getItemProtectionReason(entry);
                            if (protectionReason) throw new Error(`❌ Este item está TRAVADO (${protectionReason}). Destrave-o para depositá-lo.`);
                            depotData = await gameApiRequest('/api/game/depot/move', {
                                method: 'POST',
                                body: JSON.stringify({ itemId: entry.id, dir: direction })
                            });
                        }
                        render();
                    } catch (error) {
                        showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), error.message || 'Não foi possível mover.', true);
                    } finally {
                        busy = false;
                    }
                });
                column.appendChild(row);
            });
            return column;
        };

        const render = () => {
            const previousContentScroll = content.scrollTop;
            const previousColumnScrolls = Array.from(content.querySelectorAll('section')).map(section => section.scrollTop);
            content.innerHTML = '';
            content.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;';
            if (activeTab === 'items') {
                content.appendChild(makeDepotItemFilters(depotItemFilters, 'Buscar item no Depot e na mochila'));
                const bag = filterDepotItems(depotData?.inventory || [], depotItemFilters);
                const stored = filterDepotItems(depotData?.depot || [], depotItemFilters);
                content.append(
                    makeColumn('Mochila', bag, 'store', depotItemFilters.name ? 'Nenhum item corresponde à pesquisa.' : 'A mochila está vazia.'),
                    makeColumn(`Depot · ${depotData?.depot?.length || 0}/${depotData?.maxSlots || 0}`, stored, 'withdraw', depotItemFilters.name ? 'Nenhum item corresponde à pesquisa.' : 'O Depot está vazio.')
                );
            } else if (activeTab === 'pokemon') {
                content.appendChild(makeDepotPokemonFilters(depotPokeFilters));
                const team = filterDepotPokemon(pokes.filter(poke => poke.team && !String(poke.id).startsWith('team-')), depotPokeFilters);
                const box = filterDepotPokemon(pokes.filter(poke => !poke.team), depotPokeFilters);
                content.append(
                    makeColumn('Equipe', team, 'store', 'Nenhum Pokémon na equipe.', true),
                    makeColumn('Box', box, 'withdraw', 'Nenhum Pokémon no Box.', true)
                );
            } else if (activeTab === 'family-items') {
                renderFamilyHeader();
                content.appendChild(makeDepotItemFilters(familyItemFilters, 'Buscar item na mochila e na Família'));
                const itemReferences = [...(depotData?.inventory || []), ...(depotData?.depot || [])];
                const inventoryById = new Map(itemReferences.map(item => [String(item.itemId ?? item.id), item]));
                const enrichFamilyItem = item => {
                    const itemId = item.itemId ?? item.id;
                    const reference = inventoryById.get(String(itemId)) || globalItemApiData.get(String(itemId));
                    return {
                        ...item,
                        itemId,
                        id: item.id ?? itemId,
                        name: item.name || reference?.name || `Item #${itemId}`,
                        icon: item.icon || reference?.icon || ''
                    };
                };
                const bag = inventory.filter(item => Number(item.quantity) > 0).map(item => ({
                    ...item,
                    id: item.itemId,
                    name: inventoryById.get(String(item.itemId))?.name || globalItemApiData.get(String(item.itemId))?.name || `Item #${item.itemId}`,
                    icon: inventoryById.get(String(item.itemId))?.icon || globalItemApiData.get(String(item.itemId))?.icon || ''
                }));
                const filteredBag = filterDepotItems(bag, familyItemFilters);
                const stored = filterDepotItems((familyData?.depot?.items || []).map(enrichFamilyItem), familyItemFilters);
                content.append(
                    makeFamilyColumn('Sua mochila', filteredBag, 'deposit', 'item'),
                    makeFamilyColumn('Depósito da família', stored, 'withdraw', 'item')
                );
            } else if (activeTab === 'family-pokemon') {
                renderFamilyHeader();
                content.appendChild(makeDepotPokemonFilters(familyPokeFilters));
                const owned = filterDepotPokemon(pokes.filter(poke => !String(poke.id).startsWith('team-')), familyPokeFilters);
                const stored = filterDepotPokemon(familyData?.depot?.pokes || [], familyPokeFilters);
                content.append(
                    makeFamilyColumn('Seus Pokémon · equipe e Box', owned, 'deposit', 'pokemon'),
                    makeFamilyColumn('Depósito da família', stored, 'withdraw', 'pokemon')
                );
            }
            requestAnimationFrame(() => {
                content.scrollTop = previousContentScroll;
                content.querySelectorAll('section').forEach((section, index) => {
                    section.scrollTop = previousColumnScrolls[index] || 0;
                });
            });
        };

        const bindTab = tab => {
            tab.addEventListener('click', () => {
                activeTab = tab.dataset.tab;
                backdrop.querySelectorAll('.depot-tab').forEach(button => button.classList.toggle('active', button === tab));
                render();
            });
        };

        const configureFamilyTabs = () => {
            familyTabs.innerHTML = '';
            if (familyData?.family) {
                familyTabs.innerHTML = `
                    <button class="mk-bulk-btn depot-tab" data-tab="family-items" type="button">Família: Itens</button>
                    <button class="mk-bulk-btn depot-tab" data-tab="family-pokemon" type="button">Família: Pokémon</button>`;
                familyTabs.querySelectorAll('.depot-tab').forEach(bindTab);
                return;
            }
            const info = document.createElement('button');
            info.type = 'button';
            info.className = 'mk-bulk-btn';
            const familyConfirmed = familyData?.type === 'family';
            info.textContent = familyConfirmed ? 'Sem família' : 'Família indisponível';
            info.title = familyConfirmed
                ? 'As abas familiares aparecem somente para membros de uma família.'
                : 'Não foi possível consultar a família pelo WebSocket.';
            info.addEventListener('click', async () => {
                if (familyConfirmed) {
                    await showScriptNotice(
                        'As abas familiares não aparecem porque esta conta não pertence a nenhuma família.',
                        { title: 'Depósito da família' }
                    );
                    return;
                }
                await showScriptNotice(
                    'A conexão do jogo não respondeu à consulta familiar. Feche e abra o Depot para tentar novamente.',
                    { title: 'Família indisponível', isError: true }
                );
            });
            familyTabs.appendChild(info);
        };

        backdrop.querySelectorAll('.depot-tab').forEach(bindTab);

        try {
            const socketReady = await waitForGameSocket(5000);
            [depotData, pokes, inventory, familyData] = await Promise.all([
                gameApiRequest('/api/game/depot'),
                socketReady ? requestFreshGameEvent('pokes', 'pokes-get', { timeoutMs: 3500, attempts: 2 }) : Promise.resolve([]),
                socketReady ? requestFreshGameEvent('inventory', 'inv-get', { timeoutMs: 3000, attempts: 2 }) : Promise.resolve([]),
                socketReady ? requestFreshGameEvent('family', 'family-get', { timeoutMs: 3500, attempts: 2 }) : Promise.resolve(null)
            ]);
            configureFamilyTabs();
            status.remove();
            if (!socketReady) {
                showWindowMessage(backdrop.querySelector('.sell-confirm-modal'), 'WebSocket indisponível: Pokémon e família não puderam ser carregados.', true);
            }
            render();
        } catch (error) {
            status.textContent = 'Não foi possível abrir o Depot.';
            status.style.color = '#f56565';
            console.error('Falha ao abrir Depot portátil:', error);
        }
    }


// ============ NOVA LOJA UNIFICADA ============

async function showPortableShop(initialTab = 'buy') {
    document.querySelector('.piw-shop-backdrop')?.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'piw-shop-backdrop';
    backdrop.innerHTML = `
        <div class="piw-shop-window">
            <header class="piw-shop-header">
                <div class="piw-shop-title">
                    <span class="piw-shop-icon" data-icon>🛒</span>
                    <div>
                        <h2 data-title>Loja</h2>
                        <small data-subtitle>Compre, venda e gerencie seus itens</small>
                    </div>
                </div>
                <div class="piw-shop-balance">
                    <span class="piw-balance-label">Saldo</span>
                    <strong class="piw-balance-value">💲 —</strong>
                </div>
                <button class="piw-shop-close" type="button" aria-label="Fechar">×</button>
            </header>

            <nav class="piw-shop-tabs">
                <button class="piw-shop-tab${initialTab === 'buy' ? ' on' : ''}" data-tab="buy" type="button">
                    <span>🛒</span> Comprar
                </button>
                <button class="piw-shop-tab${initialTab === 'sell-items' ? ' on' : ''}" data-tab="sell-items" type="button">
                    <span>💰</span> Vender Itens
                </button>
                <button class="piw-shop-tab${initialTab === 'sell-pokemon' ? ' on' : ''}" data-tab="sell-pokemon" type="button">
                    <span>🐾</span> Vender Pokémon
                </button>
            </nav>

            <div class="piw-shop-body">
                <div class="piw-tab-panel" data-panel="buy">
                    <div class="piw-shop-loading">Carregando catálogo…</div>
                    <div class="piw-shop-grid"></div>
                </div>
                <div class="piw-tab-panel" data-panel="sell-items" hidden>
                    <div class="piw-filter-bar">
                        <div class="piw-filter-search">
                            <span>🔎</span>
                            <input class="piw-sell-items-search" type="search" placeholder="Buscar item…">
                        </div>
                    </div>
                    <div class="piw-shop-loading">Carregando inventário…</div>
                    <div class="piw-sell-items-list"></div>
                </div>
                <div class="piw-tab-panel" data-panel="sell-pokemon" hidden>
                    <div class="piw-filter-bar">
                        <div class="piw-filter-search">
                            <span>🔎</span>
                            <input class="piw-search-input" type="search" placeholder="Buscar Pokémon…">
                        </div>
                        <div class="piw-filter-iv">
                            <span>IV</span>
                            <input class="piw-iv-min" type="number" min="0" max="192" placeholder="de">
                            <span>–</span>
                            <input class="piw-iv-max" type="number" min="0" max="192" placeholder="até">
                        </div>
                        <div class="piw-filter-quality">
                            ${['Fraca','Comum','Incomum','Rara','Épica','Lendária','Mítica','Anciã','Divina']
                                .map(q => `<button type="button" class="piw-quality-btn on" data-quality="${q}">${q}</button>`).join('')}
                        </div>
                        <div class="piw-filter-actions">
                            <button type="button" class="piw-filter-clear">Limpar</button>
                        </div>
                    </div>
                    <div class="piw-shop-loading">Carregando Pokémon…</div>
                    <div class="piw-sell-list"></div>
                </div>
            </div>

<footer class="piw-shop-footer">
    <span class="piw-sell-summary" data-summary>—</span>
    <div class="piw-sell-actions" data-actions hidden>
        <button type="button" class="piw-btn piw-btn--ghost piw-mark-all" hidden>Marcar todos</button>
        <button type="button" class="piw-btn piw-btn--ghost piw-sell-cancel">Cancelar</button>
        <button type="button" class="piw-btn piw-btn--gold piw-sell-submit" disabled>Vender</button>
    </div>
</footer>
        </div>
    `;
    document.body.appendChild(backdrop);

    const $ = sel => backdrop.querySelector(sel);
    const $$ = sel => Array.from(backdrop.querySelectorAll(sel));
    const iconEl = $('[data-icon]');
    const titleEl = $('[data-title]');
    const subtitleEl = $('[data-subtitle]');
    const balanceEl = $('.piw-balance-value');
    const footerSummary = $('[data-summary]');
    const footerActions = $('[data-actions]');
   const submitBtn = $('.piw-sell-submit');
const markAllBtn = $('.piw-mark-all');
const locale = getGameLanguage() === 'pt' ? 'pt-BR' : 'en-US';

    const close = () => backdrop.remove();
    $('.piw-shop-close').addEventListener('click', close);
    $('.piw-sell-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

    // ---------- Estado ----------
    let shopData = null;
    let ballsData = null;
    let inventory = null;
    let pokemonList = null;
    let activeTab = initialTab;

    const TAB_META = {
        'buy':           { icon: '🛒', title: 'Comprar',         subtitle: 'Poké Bolas e itens de cura' },
        'sell-items':    { icon: '💰', title: 'Vender Itens',    subtitle: 'Selecione itens do seu inventário' },
        'sell-pokemon':  { icon: '🐾', title: 'Vender Pokémon',  subtitle: 'Selecione Pokémon do seu Box' }
    };

function switchTab(tab) {
    activeTab = tab;
    $$('.piw-shop-tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
    $$('.piw-tab-panel').forEach(p => { p.hidden = p.dataset.panel !== tab; });
    const meta = TAB_META[tab];
    iconEl.textContent = meta.icon;
    titleEl.textContent = meta.title;
    subtitleEl.textContent = meta.subtitle;
    const isSell = tab !== 'buy';
    footerActions.hidden = !isSell;
    markAllBtn.hidden = !isSell;
    if (tab === 'buy') footerSummary.textContent = 'Clique numa quantidade para comprar';
    else if (tab === 'sell-items') renderSellItems();
    else renderSellPokemon();
    updateMarkAllLabel();
}

    $$('.piw-shop-tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

    // ---------- Carregar dados ----------
    try {
        ballCatalogPromise = null;
        markCatalogPromise = null;
        const [shop, balls, inv, pokes] = await Promise.all([
            loadMarkCatalog(),
            loadBallCatalog().catch(() => ({})),
            requestFreshGameEvent('inventory', 'inv-get', { timeoutMs: 3000, attempts: 2 }),
            requestFreshGameEvent('pokes', 'pokes-get', { timeoutMs: 3000, attempts: 2 })
        ]);
        shopData = shop || {};
        ballsData = balls || {};
        inventory = inv || [];
        pokemonList = pokes || [];
        balanceEl.textContent = `💲 ${Number(shopData.gold || 0).toLocaleString(locale)}`;
    } catch (err) {
        $('.piw-shop-loading').textContent = `Falha ao carregar: ${err.message}`;
        return;
    }

    // ================================================================
    // ABA 1: COMPRAR
    // ================================================================
    const buyPanel = $('[data-panel="buy"]');
    const buyGrid = buyPanel.querySelector('.piw-shop-grid');
    buyPanel.querySelector('.piw-shop-loading').hidden = true;

    const itemCounts = new Map((inventory || []).map(i => [String(i.itemId), Number(i.quantity) || 0]));
    const ballCounts = ballsData.counts || {};
    const blockedBalls = new Set(['idle ball', 'master ball']);

    const balls = (shopData.balls || []).filter(b => !blockedBalls.has(String(b.name).toLowerCase()));
    const healItems = (shopData.items || []).filter(i =>
        ['heal', 'revive'].includes(String(i.category || '').toLowerCase()) ||
        /potion|revive/i.test(String(i.name || ''))
    );

    function renderProductCard(product, kind, owned) {
        const isBall = kind === 'ball';
        const iconSrc = isBall ? (product.iconUrl || product.icon) : (product.icon || product.iconUrl);
        const card = document.createElement('article');
        card.className = 'piw-shop-card';
        card.innerHTML = `
            <div class="piw-card-icon">
                <img src="${escapeHTML(normalizeGameItemIcon(iconSrc))}" alt="" loading="lazy">
            </div>
            <div class="piw-card-info">
                <h3>${escapeHTML(product.name)}</h3>
                <div class="piw-card-meta">
                    <span class="piw-card-owned">📦 ${owned.toLocaleString(locale)}</span>
                    ${isBall && product.catchRate ? `<span class="piw-card-rate">⚡ x${product.catchRate}</span>` : ''}
                </div>
                <div class="piw-card-price">💲 ${Number(product.priceGold || 0).toLocaleString(locale)}</div>
            </div>
            <div class="piw-card-actions">
                ${[1, 10, 100, 1000, 10000].map(q =>
                    `<button type="button" class="piw-buy-btn" data-qty="${q}">+${q.toLocaleString(locale)}</button>`
                ).join('')}
            </div>
        `;
        card.querySelector('img')?.addEventListener('error', e => e.currentTarget.remove(), { once: true });
        card.querySelectorAll('.piw-buy-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const quantity = Number(btn.dataset.qty);
                const unitPrice = Number(product.priceGold) || 0;
                const currentGold = Number(shopData.gold || 0);
                const ok = await new Promise(res => showPurchaseConfirm({
                    name: product.name, quantity, unitPrice, currentGold, currency: 'GOLD'
                }, res));
                if (!ok) return;
                btn.disabled = true;
                card.querySelectorAll('.piw-buy-btn').forEach(b => b.disabled = true);
                try {
                    const result = isBall
                        ? await gameApiRequest('/api/game/balls/buy', { method: 'POST', body: JSON.stringify({ ballId: product.id, qty: quantity }) })
                        : await buyFromMarkShop(product, 'item', quantity);
                    shopData.gold = Number(result.gold ?? shopData.gold);
                    balanceEl.textContent = `💲 ${shopData.gold.toLocaleString(locale)}`;
                    const serverCount = isBall ? result.counts?.[String(product.id)] : null;
                    const newOwned = Number(serverCount ?? (owned + quantity));
                    card.querySelector('.piw-card-owned').textContent = `📦 ${newOwned.toLocaleString(locale)}`;
                    ballCatalogPromise = null; markCatalogPromise = null;
                    showWindowMessage($('.piw-shop-window'), `Compra concluída: ${quantity.toLocaleString(locale)}× ${product.name}`);
                } catch (err) {
                    showWindowMessage($('.piw-shop-window'), `Falha: ${err.message}`, true);
                } finally {
                    card.querySelectorAll('.piw-buy-btn').forEach(b => b.disabled = false);
                }
            });
        });
        return card;
    }

    // Bloco de Poké Bolas
    if (balls.length) {
        const group = document.createElement('div');
        group.className = 'piw-shop-group';
        group.innerHTML = '<h3 class="piw-shop-group-title">⚪ Poké Bolas</h3>';
        const grid = document.createElement('div');
        grid.className = 'piw-shop-grid';
        balls.forEach(b => grid.appendChild(renderProductCard(b, 'ball', Number(ballCounts[String(b.id)] || 0))));
        group.appendChild(grid);
        buyGrid.parentElement.insertBefore(group, buyGrid.nextSibling);
    }

    // Bloco de Poções/Revives
    if (healItems.length) {
        const group = document.createElement('div');
        group.className = 'piw-shop-group';
        group.innerHTML = '<h3 class="piw-shop-group-title">💊 Poções & Revives</h3>';
        const grid = document.createElement('div');
        grid.className = 'piw-shop-grid';
        healItems.forEach(i => grid.appendChild(renderProductCard(i, 'item', Number(itemCounts.get(String(i.id)) || 0))));
        group.appendChild(grid);
        buyGrid.parentElement.insertBefore(group, buyGrid.nextSibling);
    }

    buyGrid.remove(); // remove o grid vazio placeholder

    // ================================================================
    // ABA 2: VENDER ITENS
    // ================================================================
    const sellItemsPanel = $('[data-panel="sell-items"]');
    const sellItemsList = sellItemsPanel.querySelector('.piw-sell-items-list');
    const sellItemsSearch = sellItemsPanel.querySelector('.piw-sell-items-search');

    async function loadSellableItems() {
        try {
            const entries = await (gameSocket
                ? requestGameEvent('inventory', 'inv-get', latestInventory).then(async list => {
                    if (!list.length) return readSellableInventoryFromDOM();
                    const payload = await fetch(ITEMS_JSON_URL).then(r => r.json());
                    const catalogItems = Array.isArray(payload) ? payload : (payload.items || []);
                    const catalog = new Map(catalogItems.map(i => [String(i.id), i]));
                    return list.map(entry => {
                        const item = catalog.get(String(entry.itemId));
                        return {
                            itemId: String(entry.itemId),
                            name: item?.name || `Item ${entry.itemId}`,
                            qty: Number(entry.quantity) || 0,
                            category: String(item?.category || '').toLowerCase(),
                            npcPrice: Number(item?.npcPrice) || 0,
                            icon: item?.icon || item?.image || item?.sprite || '',
                            locked: isNativeLocked(entry)
                        };
                    }).filter(i => i.qty > 0 && i.npcPrice > 0)
                      .filter(i => !['heal', 'revive', 'stone'].includes(i.category));
                })
                : readSellableInventoryFromDOM());
            return entries;
        } catch { return []; }
    }

   let sellableItemsCache = null;
async function renderSellItems() {
    const loading = sellItemsPanel.querySelector('.piw-shop-loading');
    if (!sellableItemsCache) {
        loading.hidden = false;
        // força recarregar do servidor
        latestInventory = null;
        sellableItemsCache = await loadSellableItems();
    }
    loading.hidden = true;
    sellItemsList.innerHTML = '';
    const query = sellItemsSearch.value.trim().toLowerCase();
    const filtered = sellableItemsCache
        .filter(item => !query || item.name.toLowerCase().includes(query))
        .sort((a, b) => {
            // 1) locked por último  2) nome alfabético
            const la = isItemRowLocked(a) ? 1 : 0;
            const lb = isItemRowLocked(b) ? 1 : 0;
            if (la !== lb) return la - lb;
            return a.name.localeCompare(b.name, locale);
        });

    if (!filtered.length) {
        sellItemsList.innerHTML = '<div class="piw-shop-empty">Nenhum item vendável.</div>';
        updateSellItemsSummary();
        return;
    }

    filtered.forEach(item => {
        const protectionReason = getItemProtectionReason(item);
        const isProtected = Boolean(protectionReason);
        const row = document.createElement('label');
        row.className = `piw-sell-row piw-sell-row--item${isProtected ? ' is-locked' : ''}`;
        row.dataset.locked = isProtected ? '1' : '0';
        row.innerHTML = `
            <input type="checkbox" class="piw-sell-check" data-item-id="${escapeHTML(item.itemId)}" data-item-name="${escapeHTML(item.name)}" data-unit-price="${item.npcPrice}" ${isProtected ? 'disabled' : ''}>
            <div class="piw-sell-icon">
                <img src="${escapeHTML(normalizeGameItemIcon(item.icon))}" alt="" loading="lazy">
            </div>
            <div class="piw-sell-info">
                <div class="piw-sell-name">${escapeHTML(item.name)}</div>
                <div class="piw-sell-meta">
                    <span>📦 ${item.qty.toLocaleString(locale)}</span>
                    <span class="piw-sell-price">💲 ${item.npcPrice.toLocaleString(locale)}</span>
                </div>
            </div>
            <input type="number" class="piw-sell-qty" min="1" max="${item.qty}" value="${item.qty}" ${isProtected ? 'disabled' : ''}>
            <button type="button" class="piw-sell-lock ${isProtected ? 'is-locked' : ''}" title="${protectionReason || 'Trancar'}" ${isProtected ? 'data-locked="1"' : ''}>${isProtected ? '🔒' : '🔓'}</button>
        `;
        row.querySelector('img')?.addEventListener('error', e => e.currentTarget.remove(), { once: true });

        row.querySelector('.piw-sell-lock').addEventListener('click', async e => {
            e.preventDefault(); e.stopPropagation();
            const currentlyLocked = row.classList.contains('is-locked');
            try {
                await togglePortableItemProtection(item);
                const nowLocked = !currentlyLocked;
                row.classList.toggle('is-locked', nowLocked);
                row.dataset.locked = nowLocked ? '1' : '0';
                const cb = row.querySelector('.piw-sell-check');
                const qty = row.querySelector('.piw-sell-qty');
                cb.disabled = nowLocked;
                qty.disabled = nowLocked;
                if (nowLocked) cb.checked = false;
                const lockBtn = row.querySelector('.piw-sell-lock');
                lockBtn.textContent = nowLocked ? '🔒' : '🔓';
                lockBtn.classList.toggle('is-locked', nowLocked);
                // reordena: locked vai para o fim
                const parent = sellItemsList;
                parent.appendChild(row);
                updateSellItemsSummary();
            } catch (err) {
                showWindowMessage($('.piw-shop-window'), err.message, true);
            }
        });
        row.querySelector('.piw-sell-check').addEventListener('change', updateSellItemsSummary);
        row.querySelector('.piw-sell-qty').addEventListener('input', updateSellItemsSummary);
        sellItemsList.appendChild(row);
    });
    updateSellItemsSummary();
}

function isItemRowLocked(item) {
    return Boolean(getItemProtectionReason(item));
}

    function updateSellItemsSummary() {
        let total = 0, count = 0;
        sellItemsList.querySelectorAll('.piw-sell-row').forEach(row => {
            const cb = row.querySelector('.piw-sell-check');
            const qty = row.querySelector('.piw-sell-qty');
            if (cb.checked) {
                count++;
                total += (parseInt(qty.value, 10) || 0) * (Number(cb.dataset.unitPrice) || 0);
            }
        });
        footerSummary.textContent = `${count} item(ns) selecionado(s) · 💲 ${total.toLocaleString(locale)}`;
        submitBtn.disabled = count === 0;
        submitBtn.textContent = 'Vender itens';
        const eligible = Array.from(sellItemsList.querySelectorAll('.piw-sell-check:not(:disabled)'));

        updateMarkAllLabel();
    }

    sellItemsSearch.addEventListener('input', () => renderSellItems());
    sellItemsList.addEventListener('change', updateSellItemsSummary);

    // ================================================================
    // ABA 3: VENDER POKÉMON
    // ================================================================
    const sellPokePanel = $('[data-panel="sell-pokemon"]');
    const pokeListEl = sellPokePanel.querySelector('.piw-sell-list');
    const pokeSearchInput = sellPokePanel.querySelector('.piw-search-input');
    const pokeIvMin = sellPokePanel.querySelector('.piw-iv-min');
    const pokeIvMax = sellPokePanel.querySelector('.piw-iv-max');
    const pokeQualityBtns = Array.from(sellPokePanel.querySelectorAll('.piw-quality-btn'));

    const activeQualities = new Set(pokeQualityBtns.map(b => b.dataset.quality));

    function renderSellPokemon() {
        const loading = sellPokePanel.querySelector('.piw-shop-loading');
        pokeListEl.innerHTML = '';
        const sellable = (pokemonList || []).filter(p => !p.team && !p.starter && Number(p.sellValue) > 0);
        if (!sellable.length) {
            loading.hidden = true;
            pokeListEl.innerHTML = '<div class="piw-shop-empty">Nenhum Pokémon vendável.</div>';
            updateSellPokeSummary();
            return;
        }
        loading.hidden = true;

        sellable.sort((a, b) => {
            const la = isPokemonLockedForSort(a) ? 1 : 0;
            const lb = isPokemonLockedForSort(b) ? 1 : 0;
            if (la !== lb) return la - lb;
            return String(a.name || '').localeCompare(String(b.name || ''), locale);
        });

        function isPokemonLockedForSort(poke) {
            return Boolean(poke.locked ?? poke.isLocked ?? poke.protected)
            || isNativeLocked(poke)
            || pokemonLockCache.has(String(poke.id));
        }


        sellable.forEach(poke => {
            const locked = Boolean(poke.locked ?? poke.isLocked ?? poke.protected)
                || isNativeLocked(poke)
                || pokemonLockCache.has(String(poke.id));
            const shiny = Boolean(poke.shiny);
            const qualityInfo = getPokemonQualityInfo(poke.quality);
            const qualityLabel = qualityInfo?.label || 'Comum';
            const ivTotal = Number(poke.ivTotal || 0);
            const potential = getPokemonPotentialPercent(poke.quality, ivTotal, shiny);

            const row = document.createElement('label');
            row.className = `piw-sell-row piw-sell-row--poke${locked ? ' is-locked' : ''}`;
            row.dataset.searchName = String(poke.name || '').toLowerCase();
            row.dataset.iv = String(ivTotal);
            row.dataset.quality = qualityLabel;
            row.dataset.value = String(poke.sellValue || 0);
            row.dataset.pokeId = String(poke.id);
            row.innerHTML = `
                <input type="checkbox" class="piw-sell-check" ${locked ? 'disabled' : ''}>
                <div class="piw-sell-icon">
                    <img src="${escapeHTML(getPokemonIconUrl(poke.speciesId) || '')}" alt="" loading="lazy">
                </div>
                <div class="piw-sell-info">
                    <div class="piw-sell-name">
                        ${escapeHTML(poke.name || `Pokémon ${poke.speciesId}`)}
                        ${shiny ? '<span class="piw-tag piw-tag--shiny">✨ Shiny</span>' : ''}
                        ${locked ? '<span class="piw-tag piw-tag--locked">🔒</span>' : ''}
                    </div>
                    <div class="piw-sell-meta">
                        <span>Nv ${poke.level ?? 1}</span>
                        <span>IV ${ivTotal}/192</span>
                        <span class="piw-quality-label" style="color:${qualityInfo?.color || '#a0aec0'}">${qualityLabel}</span>
                        ${potential !== null ? `<span class="piw-sell-potential">${potential}%</span>` : ''}
                    </div>
                </div>
                <div class="piw-sell-price">💲 ${Number(poke.sellValue).toLocaleString(locale)}</div>
                <button type="button" class="piw-sell-lock ${locked ? 'is-locked' : ''}" title="${locked ? 'Destrancar' : 'Trancar'}">${locked ? '🔒' : '🔓'}</button>
            `;
            row.querySelector('img')?.addEventListener('error', e => e.currentTarget.remove(), { once: true });
            row.querySelector('.piw-sell-lock').addEventListener('click', async e => {
                e.preventDefault(); e.stopPropagation();
                const isCurrentlyLocked = row.classList.contains('is-locked');
                try {
                    await toggleNativePokemonLock(poke.id, !isCurrentlyLocked);
                    const nowLocked = !isCurrentlyLocked;
                    row.classList.toggle('is-locked', nowLocked);
                    const check = row.querySelector('.piw-sell-check');
                    check.disabled = nowLocked;
                    if (nowLocked) check.checked = false;
                    const lockBtn = row.querySelector('.piw-sell-lock');
                    lockBtn.textContent = nowLocked ? '🔒' : '🔓';
                    lockBtn.classList.toggle('is-locked', nowLocked);
                    updateSellPokeSummary();
                } catch (err) {
                    showWindowMessage($('.piw-shop-window'), err.message, true);
                }
            });
            row.querySelector('.piw-sell-check').addEventListener('change', updateSellPokeSummary);
            pokeListEl.appendChild(row);
        });
        applyPokeFilters();
    }

    function applyPokeFilters() {
        const q = pokeSearchInput.value.trim().toLowerCase();
        const min = pokeIvMin.value === '' ? null : Number(pokeIvMin.value);
        const max = pokeIvMax.value === '' ? null : Number(pokeIvMax.value);
        pokeListEl.querySelectorAll('.piw-sell-row--poke').forEach(row => {
            const iv = Number(row.dataset.iv);
            const matches = (!q || row.dataset.searchName.includes(q))
                && (min === null || iv >= min)
                && (max === null || iv <= max)
                && activeQualities.has(row.dataset.quality);
            row.hidden = !matches;
            if (!matches) row.querySelector('.piw-sell-check').checked = false;
        });
        updateSellPokeSummary();
    }

    function updateSellPokeSummary() {
        const checks = Array.from(pokeListEl.querySelectorAll('.piw-sell-check:checked'));
        const total = checks.reduce((sum, c) => sum + Number(c.closest('.piw-sell-row').dataset.value || 0), 0);
        footerSummary.textContent = `${checks.length} Pokémon selecionado(s) · 💲 ${total.toLocaleString(locale)}`;
        submitBtn.disabled = checks.length === 0;
        submitBtn.textContent = 'Vender Pokémon';
        updateMarkAllLabel();
    }

    [pokeSearchInput, pokeIvMin, pokeIvMax].forEach(el => el.addEventListener('input', applyPokeFilters));
    pokeQualityBtns.forEach(btn => btn.addEventListener('click', () => {
        const q = btn.dataset.quality;
        if (activeQualities.has(q)) activeQualities.delete(q);
        else activeQualities.add(q);
        btn.classList.toggle('on', activeQualities.has(q));
        applyPokeFilters();
    }));
    sellPokePanel.querySelector('.piw-filter-clear').addEventListener('click', () => {
        pokeSearchInput.value = ''; pokeIvMin.value = ''; pokeIvMax.value = '';
        activeQualities.clear();
        pokeQualityBtns.forEach(b => { activeQualities.add(b.dataset.quality); b.classList.add('on'); });
        applyPokeFilters();
    });

    // ================================================================
    // SUBMIT (vender)
    // ================================================================
    submitBtn.addEventListener('click', async () => {
        if (activeTab === 'sell-items') return submitSellItems();
        if (activeTab === 'sell-pokemon') return submitSellPokemon();
    });

async function submitSellItems() {
    const selected = Array.from(sellItemsList.querySelectorAll('.piw-sell-row')).flatMap(row => {
        const cb = row.querySelector('.piw-sell-check');
        if (!cb.checked) return [];
        const qty = Math.min(
            parseInt(row.querySelector('.piw-sell-qty').value, 10) || 0,
            parseInt(row.querySelector('.piw-sell-qty').max, 10) || 0
        );
        return qty > 0 ? [{ itemId: cb.dataset.itemId, name: cb.dataset.itemName, qty }] : [];
    });
    if (!selected.length) return;
    const confirmed = new Set(getSellConfirmItems().map(n => n.toLowerCase()));
    const toConfirm = selected.filter(i => confirmed.has(i.name.toLowerCase())).map(i => i.name);
    if (toConfirm.length) {
        const ok = await new Promise(res => showSellConfirm(toConfirm, res));
        if (!ok) return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Vendendo…';
    try {
        const result = await sellItemsThroughShop(selected.map(({ itemId, qty }) => ({ itemId, qty })));
        shopData.gold = Number(result.gold ?? shopData.gold);
        balanceEl.textContent = `💲 ${shopData.gold.toLocaleString(locale)}`;

        // força recarregar do servidor após venda
        latestInventory = null;
        sellableItemsCache = null;
        await renderSellItems();

        showWindowMessage($('.piw-shop-window'), `Venda concluída: +💲 ${Number(result.goldGained || 0).toLocaleString(locale)}`);
    } catch (err) {
        showWindowMessage($('.piw-shop-window'), `Falha: ${err.message}`, true);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Vender itens';
        updateSellItemsSummary();
    }
}

async function submitSellPokemon() {
    const rows = Array.from(pokeListEl.querySelectorAll('.piw-sell-check:checked')).map(c => c.closest('.piw-sell-row'));
    const ids = rows.map(r => r.dataset.pokeId).filter(Boolean);
    if (!ids.length) return;
    if (!await showScriptConfirm(`Vender ${ids.length} Pokémon?`, { title: 'Confirmar', confirmLabel: 'Vender' })) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Vendendo…';
    try {
        const result = await gameApiRequest('/api/game/pokemon/sell', {
            method: 'POST',
            body: JSON.stringify({ pokeIds: ids })
        });
        latestPokemon = null;
        shopData.gold = Number(result.gold ?? shopData.gold);
        balanceEl.textContent = `💲 ${shopData.gold.toLocaleString(locale)}`;
        rows.forEach(r => r.remove());
        showWindowMessage($('.piw-shop-window'), `Venda concluída: +💲 ${Number(result.goldGained || 0).toLocaleString(locale)}`);
        sendGameMessage({ type: 'pokes-get' });
        // Recarrega a lista para refletir o servidor
        await new Promise(r => setTimeout(r, 400));
        pokemonList = await requestFreshGameEvent('pokes', 'pokes-get', { timeoutMs: 3000, attempts: 2 });
        renderSellPokemon();
        updateSellPokeSummary();
    } catch (err) {
        showWindowMessage($('.piw-shop-window'), `Falha: ${err.message}`, true);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Vender Pokémon';
    }
}
function updateMarkAllLabel() {
    if (activeTab === 'sell-items') {
        const eligible = Array.from(sellItemsList.querySelectorAll('.piw-sell-check:not(:disabled)'));
        const allSelected = eligible.length > 0 && eligible.every(c => c.checked);
        markAllBtn.textContent = allSelected ? 'Desmarcar todos' : 'Marcar todos';
    } else if (activeTab === 'sell-pokemon') {
        const eligible = Array.from(pokeListEl.querySelectorAll('.piw-sell-row--poke:not([hidden]) .piw-sell-check:not(:disabled)'));
        const allSelected = eligible.length > 0 && eligible.every(c => c.checked);
        markAllBtn.textContent = allSelected ? 'Desmarcar todos' : 'Marcar todos';
    }
}

markAllBtn.addEventListener('click', () => {
    if (activeTab === 'sell-items') {
        const eligible = Array.from(sellItemsList.querySelectorAll('.piw-sell-check:not(:disabled)'));
        const shouldSelect = eligible.some(c => !c.checked);
        eligible.forEach(c => { c.checked = shouldSelect; });
        updateSellItemsSummary();
    } else if (activeTab === 'sell-pokemon') {
        const eligible = Array.from(pokeListEl.querySelectorAll('.piw-sell-row--poke:not([hidden]) .piw-sell-check:not(:disabled)'));
        const shouldSelect = eligible.some(c => !c.checked);
        eligible.forEach(c => { c.checked = shouldSelect; });
        updateSellPokeSummary();
    }
   });
    switchTab(activeTab);
}

    function getMarketListings(payload) {
        if (Array.isArray(payload)) return payload;
        for (const key of ['listings', 'items', 'results', 'offers', 'data']) {
            if (Array.isArray(payload?.[key])) return payload[key];
            if (payload?.[key] && payload[key] !== payload) {
                const nested = getMarketListings(payload[key]);
                if (nested.length) return nested;
            }
        }
        return [];
    }

    function normalizeMarketCurrency(value) {
        const currency = String(value || 'GOLD').trim().toUpperCase();
        return /DIAM|^DD$/.test(currency) ? 'DIAMONDS' : 'GOLD';
    }

    function showGlobalMarketWindow() {
        document.querySelector('.script-market-backdrop')?.remove();
        const backdrop = document.createElement('div');
        backdrop.className = 'script-market-backdrop';
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;';
        backdrop.innerHTML = `
            <div class="mk-window script-market-window" style="width:min(760px,95vw);height:min(620px,88vh);display:flex;flex-direction:column;background:#0c161f;border:1px solid #2b4c66;border-radius:10px;box-shadow:0 16px 50px rgba(0,0,0,.75);">
                <div class="mk-head" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #1a2d3a;">
                    <b style="flex:1;color:#e2e8f0;">🌐 ${tr('globalMarket')}</b>
                    <button class="mk-bulk-btn market-refresh" type="button">↻ ${tr('refresh')}</button>
                    <button class="cfg-x market-close" type="button" aria-label="Close">×</button>
                </div>
                <div class="script-market-tabs" style="display:flex;gap:6px;padding:10px 12px 0;">
                    <button class="mk-bulk-btn market-tab on" data-mode="buy" type="button">Comprar</button>
                    <button class="mk-bulk-btn market-tab" data-mode="sell" type="button">Vender</button>
                </div>
                <div class="market-buy-controls" style="display:flex;gap:6px;padding:10px 12px 0;flex-wrap:wrap;">
                    <select class="market-category" style="background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px 9px;">
                        <option value="All">${tr('all')}</option>
                        <option value="Items" selected>${tr('items')}</option>
                        <option value="Stones">${tr('stones')}</option>
                        <option value="Poke Balls">${tr('pokeBalls')}</option>
                        <option value="Diamonds">${tr('diamonds')}</option>
                        <option value="Pokemon">${tr('pokemon')}</option>
                    </select>
                    <select class="market-sort" style="background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px 9px;">
                        <option value="recent">${tr('recent')}</option>
                        <option value="price-asc">${tr('lowestPrice')}</option>
                        <option value="price-desc">${tr('highestPrice')}</option>
                        <option value="iv-desc">${tr('highestIv')}</option>
                        <option value="power-desc">${tr('highestPower')}</option>
                        <option value="level-desc">${tr('highestLevel')}</option>
                        <option value="quality-desc">${tr('highestQuality')}</option>
                    </select>
                    <input class="market-search" type="search" placeholder="${tr('search')}" style="flex:1;min-width:180px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px 9px;">
                    <label style="display:flex;align-items:center;gap:5px;color:#a0aec0;font-size:12px;"><input class="market-show-gold" type="checkbox" checked> 💲 ${tr('gold')}</label>
                    <label style="display:flex;align-items:center;gap:5px;color:#a0aec0;font-size:12px;"><input class="market-show-diamonds" type="checkbox" checked> 💎 ${tr('diamonds')}</label>
                </div>
                <div class="market-pokemon-filters" style="display:none;gap:6px;padding:7px 12px 0;flex-wrap:wrap;">
                    <label style="display:flex;align-items:center;gap:5px;color:#a0aec0;font-size:12px;"><input class="market-shiny-only" type="checkbox"> ${tr('shinyOnly')}</label>
                    <input class="market-iv-min" type="number" min="0" max="192" placeholder="${tr('minIv')}" style="width:72px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <input class="market-iv-max" type="number" min="0" max="192" placeholder="${tr('maxIv')}" style="width:72px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <input class="market-level-min" type="number" min="1" placeholder="${tr('minLevel')}" style="width:82px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <input class="market-level-max" type="number" min="1" placeholder="${tr('maxLevel')}" style="width:82px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <input class="market-quality-min" type="number" min="0" step="0.01" placeholder="${tr('minQuality')}" style="width:88px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <input class="market-quality-max" type="number" min="0" step="0.01" placeholder="${tr('maxQuality')}" style="width:88px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;">
                    <select class="market-type" style="min-width:130px;background:#071018;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;"><option value="">${tr('allTypes')}</option></select>
                </div>
                <div class="market-sell-controls" style="display:none;padding:10px 12px 0;gap:7px;flex-wrap:wrap;">
                    <select class="market-sell-kind"><option value="item">Itens</option><option value="pokemon">Pokémon</option></select>
                    <input class="market-sell-search" type="search" placeholder="Buscar para vender...">
                    <input class="market-sell-iv-min" type="number" min="0" max="192" placeholder="IV mín.">
                    <input class="market-sell-quality-min" type="number" min="0" step="0.01" placeholder="Qualidade mín.">
                    <select class="market-sell-type"><option value="">Todos os tipos</option></select>
                    <select class="market-sell-currency"><option value="GOLD">Dólar</option><option value="DIAMONDS">Diamantes</option></select>
                    <input class="market-sell-qty" type="number" min="1" value="1" title="Quantidade">
                    <input class="market-sell-price" type="number" min="1" placeholder="Preço unitário">
                    <button class="mk-bulk-btn market-sell-submit" type="button" disabled>Anunciar</button>
                </div>
                <div class="market-status" style="padding:7px 12px;color:#a0aec0;font-size:12px;"></div>
                <div class="market-list" style="padding:0 12px 12px;overflow:auto;display:grid;gap:7px;"></div>
            </div>`;
        document.body.appendChild(backdrop);

        let activeCategory = 'Items';
        let marketMode = 'buy';
        let currentListings = [];
        let sellEntries = [];
        let selectedSellEntry = null;
        let renderLimit = 100;
        const list = backdrop.querySelector('.market-list');
        const status = backdrop.querySelector('.market-status');
        const search = backdrop.querySelector('.market-search');
        const categorySelect = backdrop.querySelector('.market-category');
        const sortSelect = backdrop.querySelector('.market-sort');
        const showGold = backdrop.querySelector('.market-show-gold');
        const showDiamonds = backdrop.querySelector('.market-show-diamonds');
        const pokemonFilters = backdrop.querySelector('.market-pokemon-filters');
        const shinyOnly = backdrop.querySelector('.market-shiny-only');
        const ivMin = backdrop.querySelector('.market-iv-min');
        const ivMax = backdrop.querySelector('.market-iv-max');
        const levelMin = backdrop.querySelector('.market-level-min');
        const levelMax = backdrop.querySelector('.market-level-max');
        const qualityMin = backdrop.querySelector('.market-quality-min');
        const qualityMax = backdrop.querySelector('.market-quality-max');
        const typeSelect = backdrop.querySelector('.market-type');
        const buyControls = backdrop.querySelector('.market-buy-controls');
        const sellControls = backdrop.querySelector('.market-sell-controls');
        const sellKind = backdrop.querySelector('.market-sell-kind');
        const sellSearch = backdrop.querySelector('.market-sell-search');
        const sellIvMin = backdrop.querySelector('.market-sell-iv-min');
        const sellQualityMin = backdrop.querySelector('.market-sell-quality-min');
        const sellType = backdrop.querySelector('.market-sell-type');
        const sellCurrency = backdrop.querySelector('.market-sell-currency');
        const sellQty = backdrop.querySelector('.market-sell-qty');
        const sellPrice = backdrop.querySelector('.market-sell-price');
        const sellSubmit = backdrop.querySelector('.market-sell-submit');
        const close = () => backdrop.remove();

        const renderSell = () => {
            const query = sellSearch.value.trim().toLocaleLowerCase();
            const isPokemon = sellKind.value === 'pokemon';
            sellIvMin.style.display = isPokemon ? '' : 'none';
            sellQualityMin.style.display = isPokemon ? '' : 'none';
            sellType.style.display = isPokemon ? '' : 'none';
            sellQty.style.display = isPokemon ? 'none' : '';
            const filtered = sellEntries.filter(entry => entry.kind === sellKind.value)
                .filter(entry => !query || entry.name.toLocaleLowerCase().includes(query))
                .filter(entry => !isPokemon || sellIvMin.value === '' || Number(entry.ivTotal) >= Number(sellIvMin.value))
                .filter(entry => !isPokemon || sellQualityMin.value === '' || Number(entry.quality) >= Number(sellQualityMin.value))
                .filter(entry => !isPokemon || !sellType.value || entry.type1 === sellType.value || entry.type2 === sellType.value)
                .sort((a, b) => isPokemon
                    ? Number(b.ivTotal) - Number(a.ivTotal) || Number(b.quality) - Number(a.quality) || Number(b.level) - Number(a.level)
                    : a.name.localeCompare(b.name, 'pt-BR'));
            list.innerHTML = '';
            status.textContent = `${filtered.length} disponível(is) para anunciar`;
            filtered.forEach(entry => {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = `market-sell-row${selectedSellEntry === entry ? ' on' : ''}`;
                const details = isPokemon
                    ? `Nv ${entry.level ?? 1} · IV ${entry.ivTotal ?? 0}/192 · ${formatPokemonQualityWithPotential(entry.quality, entry.ivTotal)}${entry.shiny ? ' · ✨ Shiny' : ''}`
                    : `${Number(entry.quantity || 0).toLocaleString('pt-BR')} na mochila`;
                row.innerHTML = `${entry.icon ? `<img src="${escapeHTML(entry.icon)}" alt="">` : ''}<span><b>${escapeHTML(entry.name)}</b><small>${escapeHTML(details)}</small></span>`;
                row.addEventListener('click', () => {
                    selectedSellEntry = entry;
                    sellQty.max = String(entry.quantity || 1);
                    sellQty.value = String(Math.min(Number(sellQty.value) || 1, entry.quantity || 1));
                    sellSubmit.disabled = !(Number(sellPrice.value) >= 1);
                    renderSell();
                });
                list.appendChild(row);
            });
        };

        const loadSell = async () => {
            status.textContent = tr('loading');
            try {
                const [inventory, pokemon, itemPayload, ballPayload] = await Promise.all([
                    requestFreshGameEvent('inventory', 'inv-get', { timeoutMs: 3500, attempts: 2 }),
                    requestFreshGameEvent('pokes', 'pokes-get', { timeoutMs: 3500, attempts: 2 }),
                    fetch(ITEMS_JSON_URL).then(response => response.json()),
                    loadBallCatalog().catch(() => ({ catalog: [], counts: {} }))
                ]);
                const itemMap = new Map((itemPayload.items || []).map(item => [String(item.id), item]));
                sellEntries = inventory.filter(entry => Number(entry.quantity) > 0).map(entry => {
                    const item = itemMap.get(String(entry.itemId)) || {};
                    return { kind: 'item', marketKind: 'item', refId: Number(entry.itemId), name: item.name || `Item ${entry.itemId}`, icon: normalizeGameItemIcon(item.icon), quantity: Number(entry.quantity) };
                });
                const balls = Array.isArray(ballPayload.catalog) ? ballPayload.catalog : (ballPayload.catalog?.balls || []);
                balls.forEach(ball => {
                    const quantity = Number(ballPayload.counts?.[String(ball.id)] || 0);
                    if (quantity > 0) sellEntries.push({ kind: 'item', marketKind: 'ball', refId: Number(ball.id), name: ball.name, icon: ball.iconUrl || normalizeGameItemIcon(ball.icon), quantity });
                });
                pokemon.filter(poke => !poke.starter && !poke.market && !poke.listed).forEach(poke => sellEntries.push({
                    ...poke, kind: 'pokemon', name: poke.name || `Pokémon ${poke.speciesId}`, icon: getPokemonIconUrl(poke.speciesId), quantity: 1
                }));
                const types = [...new Set(pokemon.flatMap(poke => [poke.type1, poke.type2]).filter(Boolean))].sort();
                sellType.innerHTML = `<option value="">Todos os tipos</option>${types.map(type => `<option value="${escapeHTML(type)}">${escapeHTML(type)}</option>`).join('')}`;
                selectedSellEntry = null;
                sellSubmit.disabled = true;
                renderSell();
            } catch (error) {
                status.textContent = `Não foi possível carregar seus itens e Pokémon: ${error.message}`;
            }
        };

        const render = () => {
            const query = search.value.trim().toLocaleLowerCase();
            let filtered = currentListings.filter(entry => {
                const ref = entry.item || entry.pokemon || entry.product || {};
                const name = entry.name || entry.title || entry.itemName || entry.pokemonName || ref.name || ref.title || '';
                if (query && !String(name).toLocaleLowerCase().includes(query)) return false;
                const entryCurrency = normalizeMarketCurrency(entry.currency || entry.currencyType || ref.currency || ref.currencyType);
                if (entryCurrency === 'GOLD' && !showGold.checked) return false;
                if (entryCurrency === 'DIAMONDS' && !showDiamonds.checked) return false;
                if (activeCategory === 'Pokemon') {
                    const iv = Number(entry.ivTotal ?? -1);
                    const level = Number(entry.level ?? -1);
                    const quality = Number(entry.quality ?? -1);
                    if (shinyOnly.checked && !entry.shiny) return false;
                    if (ivMin.value !== '' && iv < Number(ivMin.value)) return false;
                    if (ivMax.value !== '' && iv > Number(ivMax.value)) return false;
                    if (levelMin.value !== '' && level < Number(levelMin.value)) return false;
                    if (levelMax.value !== '' && level > Number(levelMax.value)) return false;
                    if (qualityMin.value !== '' && quality < Number(qualityMin.value)) return false;
                    if (qualityMax.value !== '' && quality > Number(qualityMax.value)) return false;
                    if (typeSelect.value && entry.type1 !== typeSelect.value && entry.type2 !== typeSelect.value) return false;
                }
                return true;
            });
            const sorters = {
                'price-asc': (a, b) => Number(a.price) - Number(b.price),
                'price-desc': (a, b) => Number(b.price) - Number(a.price),
                'iv-desc': (a, b) => Number(b.ivTotal ?? -1) - Number(a.ivTotal ?? -1),
                'power-desc': (a, b) => Number(b.power ?? -1) - Number(a.power ?? -1),
                'level-desc': (a, b) => Number(b.level ?? -1) - Number(a.level ?? -1),
                'quality-desc': (a, b) => Number(b.quality ?? -1) - Number(a.quality ?? -1)
            };
            if (sorters[sortSelect.value]) filtered = [...filtered].sort(sorters[sortSelect.value]);
            const visible = filtered.slice(0, renderLimit);
            list.innerHTML = '';
            const categoryLabel = categorySelect.options[categorySelect.selectedIndex]?.text || activeCategory;
            status.textContent = filtered.length
                ? `${tr('showing')} ${visible.length.toLocaleString()} ${tr('of')} ${filtered.length.toLocaleString()} ${categoryLabel}`
                : tr('noListings');
            visible.forEach(entry => {
                const ref = entry.item || entry.pokemon || entry.product || {};
                const name = entry.name || entry.title || entry.itemName || entry.pokemonName || ref.name || ref.title || '—';
                const price = Number(entry.price ?? entry.totalPrice ?? entry.value ?? 0);
                const quantity = Number(entry.quantity ?? entry.qty ?? entry.amount ?? 1);
                const quality = entry.quality ?? ref.quality;
                const ivTotal = entry.ivTotal ?? ref.ivTotal ?? entry.iv ?? ref.iv;
                const stats = entry.stats || ref.stats || {};
                const statText = entry.kind === 'pokemon'
                    ? [
                        ['HP', stats.hp], ['ATK', stats.atk], ['DEF', stats.def],
                        ['SP.ATK', stats.spAtk], ['SP.DEF', stats.spDef], ['SPD', stats.speed]
                    ].filter(([, value]) => value != null).map(([label, value]) => `${label} ${value}`).join(' · ')
                    : '';
                const row = document.createElement('div');
                row.style.cssText = 'display:grid;grid-template-columns:minmax(190px,1fr) auto auto auto;gap:12px;align-items:center;background:#14222d;border:1px solid #1f3545;border-radius:7px;padding:9px 11px;color:#e2e8f0;';
                const potential = quality != null && ivTotal != null
                    ? getPokemonPotentialPercent(quality, ivTotal, entry.shiny ?? ref.shiny)
                    : null;
                const details = [
                    ivTotal != null ? `${tr('ivTotal')}: ${ivTotal}/192` : '',
                    quality != null ? `Q: ${Number(quality).toFixed(2)}${potential !== null ? ` (${potential}%)` : ''}` : ''
                ].filter(Boolean).join(' · ');
                const offerOnly = Boolean(entry.offerOnly || price <= 0);
                const currency = normalizeMarketCurrency(entry.currency || entry.currencyType || ref.currency || ref.currencyType);
                const currencyIcon = currency === 'DIAMONDS' ? '💎' : '💲';
                const isPokemon = entry.kind === 'pokemon' || activeCategory === 'Pokemon';
                const pokemonIconUrl = isPokemon
                    ? (getPokemonIconUrl(entry.speciesId ?? ref.speciesId ?? entry.pokeId ?? ref.pokeId)
                        || getPokemonIconUrlByName(name))
                    : '';
                const itemIconHTML = isPokemon ? '' : getMarketItemIconHTML(name, entry, ref, activeCategory);
                row.innerHTML = `
                    <div style="display:flex;align-items:center;gap:9px;min-width:0;">${pokemonIconUrl ? `<img class="market-pokemon-icon" src="${escapeHTML(pokemonIconUrl)}" alt="">` : itemIconHTML}<span style="min-width:0;"><b>${escapeHTML(name)}</b>${details ? `<small style="display:block;color:#90cdf4;margin-top:2px;">${escapeHTML(details)}</small>` : ''}${statText ? `<small style="display:block;color:#a0aec0;margin-top:2px;">${escapeHTML(statText)}</small>` : ''}</span></div>
                    <span style="color:#a0aec0;">${tr('quantity')}: <b style="color:#e2e8f0;">${quantity.toLocaleString(getGameLanguage() === 'pt' ? 'pt-BR' : 'en-US')}</b></span>
                    <b style="color:#f6c453;">${offerOnly ? tr('offerOnly') : `${currencyIcon} ${price.toLocaleString(getGameLanguage() === 'pt' ? 'pt-BR' : 'en-US')}`}</b>`;
                row.querySelector('.market-pokemon-icon')?.addEventListener('error', event => event.currentTarget.remove(), { once: true });
                row.querySelector('.market-item-icon')?.addEventListener('error', event => {
                    const icon = event.currentTarget;
                    let pendingSources = [];
                    try { pendingSources = JSON.parse(icon.dataset.iconFallbacks || '[]'); } catch { pendingSources = []; }
                    const nextSource = pendingSources.shift();
                    if (nextSource) {
                        icon.dataset.iconFallbacks = JSON.stringify(pendingSources);
                        icon.src = nextSource;
                        return;
                    }
                    const fallback = document.createElement('span');
                    fallback.className = 'market-item-emoji';
                    fallback.setAttribute('aria-hidden', 'true');
                    fallback.textContent = /stone/i.test(name) ? '🪨' : '🌿';
                    icon.replaceWith(fallback);
                });
                const buyButton = document.createElement('button');
                const quantityInput = document.createElement('input');
                quantityInput.type = 'number';
                quantityInput.min = '1';
                quantityInput.max = String(Math.max(1, quantity));
                quantityInput.value = '1';
                quantityInput.title = 'Quantidade a comprar';
                quantityInput.style.cssText = 'width:72px;background:#0c161f;color:#e2e8f0;border:1px solid #273f52;border-radius:5px;padding:6px;';
                quantityInput.hidden = entry.kind === 'pokemon' || quantity <= 1;
                buyButton.type = 'button';
                buyButton.className = 'mk-bulk-btn market-buy';
                buyButton.textContent = tr('buy');
                buyButton.style.cssText = 'width:auto;min-width:76px;min-height:32px;padding:6px 12px;grid-column:auto;';
                buyButton.disabled = offerOnly;
                buyButton.addEventListener('click', async () => {
                    buyButton.disabled = true;
                    try {
                        const buyQuantity = entry.kind === 'pokemon' ? 1 : Math.max(1, Math.min(quantity, parseInt(quantityInput.value, 10) || 1));
                        const characterData = await gameApiRequest('/api/characters/me');
                        const currentBalance = currency === 'DIAMONDS'
                            ? Number(characterData.character?.diamonds || 0)
                            : Number(characterData.character?.gold || 0);
                        const confirmed = await new Promise(resolve => showPurchaseConfirm({
                            name,
                            quantity: buyQuantity,
                            unitPrice: price,
                            currentBalance,
                            currency
                        }, resolve));
                        if (!confirmed) {
                            buyButton.disabled = false;
                            return;
                        }
                        const marketAction = entry.kind === 'pokemon'
                            ? { action: 'buy', id: entry.id, quantity: 1 }
                            : {
                                action: 'buy-stack',
                                kind: entry.kind,
                                refId: entry.refId,
                                price: entry.price,
                                currency: entry.currency,
                                quantity: buyQuantity,
                                ids: (entry.ids ?? [entry.id]).slice(0, buyQuantity)
                            };
                        await gameApiRequest('/api/game/market/action', {
                            method: 'POST',
                            body: JSON.stringify(marketAction)
                        });
                        if (quantity <= buyQuantity || entry.kind === 'pokemon') {
                            currentListings = currentListings.filter(item => item !== entry);
                        } else {
                            entry.quantity = quantity - buyQuantity;
                        }
                        render();
                        showWindowMessage(backdrop.querySelector('.script-market-window'), tr('purchaseDone'));
                    } catch (error) {
                        showWindowMessage(backdrop.querySelector('.script-market-window'), `${tr('purchaseFailed')} ${error.message}`, true);
                        buyButton.disabled = false;
                    }
                });
                const buyActions = document.createElement('div');
                buyActions.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:6px;white-space:nowrap;';
                buyActions.append(quantityInput, buyButton);
                row.appendChild(buyActions);
                list.appendChild(row);
            });
            if (visible.length < filtered.length) {
                const more = document.createElement('button');
                more.type = 'button';
                more.className = 'mk-bulk-btn';
                more.style.cssText = 'margin:5px auto;padding:8px 18px;';
                more.textContent = `${tr('loadMore')} (+${Math.min(100, filtered.length - visible.length)})`;
                more.addEventListener('click', () => {
                    renderLimit += 100;
                    render();
                });
                list.appendChild(more);
            }
        };

        const load = async () => {
            status.textContent = tr('loading');
            list.innerHTML = '';
            try {
                const payload = await gameApiRequest(`/api/game/market?category=${encodeURIComponent(activeCategory)}`);
                currentListings = getMarketListings(payload);
                const types = [...new Set(currentListings.flatMap(entry => [entry.type1, entry.type2]).filter(Boolean))].sort();
                typeSelect.innerHTML = `<option value="">${tr('allTypes')}</option>${types.map(type => `<option value="${escapeHTML(type)}">${escapeHTML(type)}</option>`).join('')}`;
                pokemonFilters.style.display = activeCategory === 'Pokemon' ? 'flex' : 'none';
                renderLimit = 100;
                render();
            } catch (error) {
                console.warn('Falha ao carregar o mercado global:', error);
                status.textContent = `${tr('loadFailed')} ${error.message || ''}`.trim();
            }
        };
        backdrop.querySelector('.market-close').addEventListener('click', close);
        backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
        backdrop.querySelector('.market-refresh').addEventListener('click', () => marketMode === 'sell' ? loadSell() : load());
        backdrop.querySelectorAll('.market-tab').forEach(tab => tab.addEventListener('click', () => {
            marketMode = tab.dataset.mode;
            backdrop.querySelectorAll('.market-tab').forEach(button => button.classList.toggle('on', button === tab));
            buyControls.style.display = marketMode === 'buy' ? 'flex' : 'none';
            pokemonFilters.style.display = marketMode === 'buy' && activeCategory === 'Pokemon' ? 'flex' : 'none';
            sellControls.style.display = marketMode === 'sell' ? 'flex' : 'none';
            if (marketMode === 'sell') loadSell(); else load();
        }));
        [sellKind, sellSearch, sellIvMin, sellQualityMin, sellType].forEach(control => control.addEventListener('input', () => {
            selectedSellEntry = null;
            sellSubmit.disabled = true;
            renderSell();
        }));
        sellPrice.addEventListener('input', () => { sellSubmit.disabled = !selectedSellEntry || !(Number(sellPrice.value) >= 1); });
        sellSubmit.addEventListener('click', async () => {
            const entry = selectedSellEntry;
            const price = Math.floor(Number(sellPrice.value));
            if (!entry || price < 1) return;
            const quantity = entry.kind === 'pokemon' ? 1 : Math.max(1, Math.min(entry.quantity, Math.floor(Number(sellQty.value) || 1)));
            const message = `Anunciar ${quantity}× ${entry.name} por ${price.toLocaleString('pt-BR')} ${sellCurrency.value === 'DIAMONDS' ? 'diamante(s)' : 'dólar(es)'}?`;
            if (!await showScriptConfirm(message, { title: 'Confirmar anúncio', confirmLabel: 'Anunciar' })) return;
            sellSubmit.disabled = true;
            try {
                const action = entry.kind === 'pokemon'
                    ? { action: 'sell-pokemon', capturedId: entry.id, price, currency: sellCurrency.value }
                    : { action: 'sell', kind: entry.marketKind, refId: entry.refId, quantity, price, currency: sellCurrency.value };
                await gameApiRequest('/api/game/market/action', { method: 'POST', body: JSON.stringify(action) });
                showWindowMessage(backdrop.querySelector('.script-market-window'), `Anúncio criado: ${entry.name}`);
                await loadSell();
            } catch (error) {
                showWindowMessage(backdrop.querySelector('.script-market-window'), `Falha ao anunciar: ${error.message}`, true);
                sellSubmit.disabled = false;
            }
        });
        categorySelect.addEventListener('change', () => {
            activeCategory = categorySelect.value;
            renderLimit = 100;
            if (activeCategory !== 'Pokemon' && ['iv-desc', 'power-desc', 'level-desc', 'quality-desc'].includes(sortSelect.value)) {
                sortSelect.value = 'recent';
            }
            load();
        });
        [search, sortSelect, showGold, showDiamonds, shinyOnly, ivMin, ivMax, levelMin, levelMax, qualityMin, qualityMax, typeSelect].forEach(control => control.addEventListener('input', () => {
            renderLimit = 100;
            render();
        }));
        load();
    }

    function suppressHuntServiceIcons() {
        const captureBar = document.querySelector('[data-guide="capture-bar"]');
        if (!captureBar) return;
        captureBar.querySelectorAll('.script-open-global-market').forEach(button => button.remove());
        captureBar.querySelectorAll('.cap-shop-link').forEach(link => { link.style.display = 'none'; });
    }

    let ballCatalogPromise = null;

    function loadBallCatalog() {
        if (!ballCatalogPromise) {
            ballCatalogPromise = gameApiRequest('/api/game/balls').catch(error => {
                ballCatalogPromise = null;
                throw error;
            });
        }
        return ballCatalogPromise;
    }

    function injectHuntBallEnhancements(ballWindow) {
        if (!ballWindow) return;

        const header = ballWindow.querySelector('.ball-head');
        if (!isHuntSellActive()) header?.querySelector('.hunt-sell-open')?.remove();
        if (header && isHuntSellActive() && !header.querySelector('.hunt-sell-open')) {
            const sellButton = document.createElement('button');
            sellButton.type = 'button';
            sellButton.className = 'mk-bulk-btn hunt-sell-open';
            sellButton.textContent = '💰 Vender itens';
            sellButton.addEventListener('click', async () => {
                ballWindow.querySelector('.cfg-x')?.click();
                await new Promise(resolve => setTimeout(resolve, 100));
                showHuntSellWindow();
            });
            header.querySelector('.cfg-x')?.before(sellButton);
        }

        if (!isHuntBulkBuyActive()) {
            ballWindow.querySelectorAll('.script-hunt-bulk').forEach(button => button.remove());
            ballWindow.querySelectorAll('.ball-actions').forEach(actions => delete actions.dataset.bulkEnhanced);
            return;
        }
        ballWindow.querySelectorAll('.ball-row').forEach(row => {
            const actions = row.querySelector('.ball-actions');
            const ballName = row.querySelector('.ball-name')?.textContent?.trim();
            if (!actions || !ballName || !actions.querySelector('.ball-buy') || actions.dataset.bulkEnhanced) return;

            [1000, 10000].forEach(quantity => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'ball-buy script-hunt-bulk';
                button.textContent = `+${quantity.toLocaleString('pt-BR')}`;
                button.addEventListener('click', async () => {
                    button.disabled = true;
                    try {
                        const data = await loadBallCatalog();
                        const ball = data.catalog?.find(item => item.name === ballName);
                        if (!ball?.id) throw new Error('Poké Bola não encontrada no catálogo.');
                        const confirmed = await new Promise(resolve => showPurchaseConfirm({
                            name: ballName,
                            quantity,
                            unitPrice: Number(ball.priceGold) || 0,
                            currentGold: Number(data.gold) || 0
                        }, resolve));
                        if (!confirmed) return;
                        const result = await gameApiRequest('/api/game/balls/buy', {
                            method: 'POST',
                            body: JSON.stringify({ ballId: ball.id, qty: quantity })
                        });
                        const owned = row.querySelector('.ball-own');
                        const count = result.counts?.[String(ball.id)];
                        if (owned && count !== undefined) owned.textContent = `${Number(count).toLocaleString('pt-BR')}× em estoque`;
                        const gold = ballWindow.querySelector('.ball-gold');
                        if (gold && result.gold !== undefined) gold.textContent = `💲 ${Number(result.gold).toLocaleString('pt-BR')}`;
                        ballCatalogPromise = null;
                        showWindowMessage(ballWindow, `Compra concluída: ${quantity.toLocaleString('pt-BR')}× ${ballName}`);
                    } catch (error) {
                        console.error('Falha ao comprar Poké Bolas:', error);
                        showWindowMessage(ballWindow, `Não foi possível concluir a compra: ${error.message}`, true);
                    } finally {
                        button.disabled = false;
                    }
                });
                actions.appendChild(button);
            });
            actions.dataset.bulkEnhanced = 'true';
        });
    }

    let markCatalogPromise = null;

    function loadMarkCatalog() {
        if (!markCatalogPromise) {
            markCatalogPromise = gameApiRequest('/api/game/shop').catch(error => {
                markCatalogPromise = null;
                throw error;
            });
        }
        return markCatalogPromise;
    }

    async function buyFromMarkShop(product, kind, quantity) {
        const requestedQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
        let remaining = requestedQuantity;
        let result = null;
        while (remaining > 0) {
            const batchQuantity = Math.min(1000, remaining);
            const payload = kind === 'ball'
                ? { ballId: product.id, qty: batchQuantity }
                : { itemId: product.id, qty: batchQuantity };
            result = await gameApiRequest('/api/game/shop/buy', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            remaining -= batchQuantity;
        }
        return result || {};
    }

    function setNativeInputValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, String(value));
        else input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    let markQualityMenuOpen = false;

    function findNativeMarkWindow() {
        return Array.from(document.querySelectorAll('.mk-window')).find(windowElement => {
            if (windowElement.classList.contains('script-market-window') || windowElement.closest('.script-market-backdrop')) return false;
            const title = windowElement.querySelector('.ball-head, .mk-head')?.textContent || '';
            return /(?:Loja\s+do\s+Mark|Mark(?:'s)?\s+Shop)/i.test(title);
        }) || null;
    }

    function isMarkQualitySelected(button) {
        return button.classList.contains('on')
            || button.classList.contains('active')
            || button.getAttribute('aria-pressed') === 'true'
            || button.dataset.active === 'true'
            || button.querySelector('input[type="checkbox"]')?.checked === true;
    }

    function injectMarkQualityMultiSelect(mkWindow) {
        if (!preferenceEnabled(STORAGE_MARK_QUALITY_PICKER)) return;
        const qualityPattern = /^(?:fraca|comum|incomum|rara|épica|epica|lendária|lendaria|mítica|mitica|anciã|ancia|divina|poor|common|uncommon|rare|epic|legendary|mythic|ancient|divine)$/i;
        const qualityButtons = Array.from(mkWindow.querySelectorAll('button:not(.script-quality-toggle)'))
            .filter(button => qualityPattern.test(button.textContent.trim()));
        if (qualityButtons.length < 3) return;
        const parent = qualityButtons[0].parentElement;
        const siblings = qualityButtons.filter(button => button.parentElement === parent);
        if (siblings.length < 3 || parent.querySelector('.script-quality-multiselect')) return;
        mkWindow.querySelectorAll('.script-quality-dropdown').forEach(dropdown => dropdown.remove());
        siblings.forEach(button => { button.style.display = 'none'; button.dataset.scriptQualityNative = 'true'; });

        const picker = document.createElement('div');
        picker.className = 'script-quality-multiselect';
        picker.innerHTML = '<button class="mk-bulk-btn script-quality-toggle" type="button" aria-haspopup="true" aria-expanded="false">Qualidades: todas ▾</button>';
        const toggle = picker.querySelector('.script-quality-toggle');

        const updateLabel = (dropdown = mkWindow.querySelector('.script-quality-dropdown')) => {
            const selectedCount = dropdown
                ? dropdown.querySelectorAll('input[type="checkbox"]:checked').length
                : siblings.filter(isMarkQualitySelected).length;
            toggle.textContent = selectedCount ? `Qualidades: ${selectedCount} selecionada(s) ▾` : 'Qualidades: todas ▾';
        };

        const closeDropdown = () => {
            mkWindow.querySelector('.script-quality-dropdown')?.remove();
            markQualityMenuOpen = false;
            toggle.setAttribute('aria-expanded', 'false');
        };

        const openDropdown = () => {
            mkWindow.querySelector('.script-quality-dropdown')?.remove();
            const dropdown = document.createElement('div');
            dropdown.className = 'script-quality-dropdown';
            dropdown.setAttribute('role', 'menu');
            siblings.forEach(button => {
                const labelText = button.textContent.trim();
                const option = document.createElement('label');
                option.className = 'script-quality-option';
                option.innerHTML = `<input type="checkbox" data-label="${escapeHTML(labelText)}"> <span>${escapeHTML(labelText)}</span>`;
                const checkbox = option.querySelector('input');
                checkbox.checked = isMarkQualitySelected(button);
                checkbox.addEventListener('change', event => {
                    event.stopPropagation();
                    markQualityMenuOpen = true;
                    updateLabel(dropdown);
                    button.click();
                    [50, 150, 300].forEach(delay => setTimeout(() => {
                        if (!picker.isConnected || siblings.some(nativeButton => !nativeButton.isConnected)) {
                            picker.remove();
                            mkWindow.querySelector('.script-quality-dropdown')?.remove();
                            injectMarkQualityMultiSelect(mkWindow);
                            return;
                        }
                        const currentDropdown = mkWindow.querySelector('.script-quality-dropdown');
                        if (currentDropdown) updateLabel(currentDropdown);
                        else if (picker.isConnected && markQualityMenuOpen) openDropdown();
                    }, delay));
                });
                dropdown.appendChild(option);
            });
            ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(type => dropdown.addEventListener(type, event => event.stopPropagation()));
            mkWindow.appendChild(dropdown);
            const toggleRect = toggle.getBoundingClientRect();
            const windowRect = mkWindow.getBoundingClientRect();
            const desiredLeft = toggleRect.left - windowRect.left;
            const maxLeft = Math.max(8, windowRect.width - dropdown.offsetWidth - 8);
            dropdown.style.left = `${Math.max(8, Math.min(desiredLeft, maxLeft))}px`;
            dropdown.style.top = `${toggleRect.bottom - windowRect.top + 4}px`;
            markQualityMenuOpen = true;
            toggle.setAttribute('aria-expanded', 'true');
            updateLabel(dropdown);
        };

        toggle.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (mkWindow.querySelector('.script-quality-dropdown')) closeDropdown();
            else openDropdown();
        });

        const outside = event => {
            if (!picker.isConnected) return document.removeEventListener('pointerdown', outside, true);
            const dropdown = mkWindow.querySelector('.script-quality-dropdown');
            if (!picker.contains(event.target) && !dropdown?.contains(event.target)) closeDropdown();
        };
        document.addEventListener('pointerdown', outside, true);
        parent.appendChild(picker);
        updateLabel();
        if (markQualityMenuOpen) requestAnimationFrame(openDropdown);
    }

    function legacyInjectMarkBuyQuantities(mkWindow) {
        const quantityBar = mkWindow.querySelector('.mk-qtybar');
        const quantityInput = quantityBar?.querySelector('input.mk-qty');
        if (!quantityBar || !quantityInput) return;
        Array.from(quantityBar.children).forEach(child => {
            if (!child.classList.contains('script-mark-qty-presets')) child.style.display = 'none';
        });
        quantityBar.style.justifyContent = 'center';
        if (quantityBar.querySelector('.script-mark-qty-presets')) return;

        const presets = document.createElement('span');
        presets.className = 'script-mark-qty-presets';
        presets.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;justify-content:center;width:100%;';
        [1, 10, 100, 1000, 10000].forEach(quantity => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'mk-bulk-btn';
            button.textContent = quantity.toLocaleString('pt-BR');
            button.addEventListener('click', () => {
                mkWindow.dataset.scriptBuyQty = String(quantity);
                setNativeInputValue(quantityInput, quantity);
                presets.querySelectorAll('button').forEach(item => item.classList.toggle('on', item === button));
            });
            presets.appendChild(button);
        });
        quantityInput.addEventListener('input', () => delete mkWindow.dataset.scriptBuyQty);
        quantityBar.appendChild(presets);

        if (!mkWindow.dataset.scriptBuyIntercepted) {
            mkWindow.addEventListener('click', async event => {
                const buyButton = event.target.closest('button.mk-buy');
                const quantity = parseInt(mkWindow.dataset.scriptBuyQty, 10);
                if (!buyButton || !quantity) return;
                event.preventDefault();
                event.stopImmediatePropagation();

                const row = buyButton.closest('.mk-row');
                const name = row?.querySelector('.mk-name')?.textContent?.trim();
                if (!name) return;
                buyButton.disabled = true;
                try {
                    const [catalog, characterData] = await Promise.all([
                        loadMarkCatalog(),
                        gameApiRequest('/api/characters/me').catch(() => null)
                    ]);
                    const ball = catalog.balls?.find(item => item.name === name);
                    const item = catalog.items?.find(entry => entry.name === name);
                    const product = ball || item;
                    if (!product) throw new Error('Produto não encontrado.');
                    const displayedGold = parseGameNumber(mkWindow.querySelector('.mk-gold')?.textContent);
                    const currentGold = Math.max(
                        0,
                        Number(characterData?.character?.gold || 0),
                        Number(characterData?.gold || 0),
                        Number(displayedGold || 0),
                        Number(catalog.gold || 0)
                    );
                    const confirmed = await new Promise(resolve => showPurchaseConfirm({
                        name,
                        quantity,
                        unitPrice: Number(product.priceGold) || 0,
                        currentGold
                    }, resolve));
                    if (!confirmed) return;
                    const result = await buyFromMarkShop(product, ball ? 'ball' : 'item', quantity);
                    const gold = mkWindow.querySelector('.mk-gold');
                    if (gold && result.gold !== undefined) gold.textContent = `💲 ${Number(result.gold).toLocaleString('pt-BR')}`;
                    markCatalogPromise = null;
                    showWindowMessage(mkWindow, `Compra concluída: ${quantity.toLocaleString('pt-BR')}× ${name}`);
                    setTimeout(() => {
                        const currentInput = mkWindow.querySelector('.mk-qty');
                        if (currentInput) setNativeInputValue(currentInput, quantity);
                        mkWindow.dataset.scriptBuyQty = String(quantity);
                    }, 0);
                } catch (error) {
                    showWindowMessage(mkWindow, `Não foi possível concluir a compra: ${error.message}`, true);
                } finally {
                    buyButton.disabled = false;
                }
            }, true);
            mkWindow.dataset.scriptBuyIntercepted = 'true';
        }
    }

    async function injectMarkBuyQuantities(mkWindow) {
        if (!preferenceEnabled(STORAGE_MARK_QUICK_BUY)) return;
        const quantityBar = mkWindow.querySelector('.mk-qtybar');
        if (quantityBar) quantityBar.style.display = 'none';
        const buyTab = Array.from(mkWindow.querySelectorAll('.mk-tab')).some(tab => tab.classList.contains('on') && /Comprar|Buy/i.test(tab.textContent));
        const rows = Array.from(mkWindow.querySelectorAll('.mk-row')).filter(row => row.querySelector('.mk-name'));
        if (!buyTab || !rows.length) return;
        let catalog;
        try { catalog = await loadMarkCatalog(); } catch { return; }
        rows.forEach(row => {
            if (row.querySelector('.script-mark-row-buy')) return;
            const name = row.querySelector('.mk-name')?.textContent?.trim();
            const ball = catalog.balls?.find(product => product.name === name);
            const item = catalog.items?.find(product => product.name === name);
            const product = ball || item;
            if (!product) return;
            row.querySelector('button.mk-buy')?.style.setProperty('display', 'none');
            const actions = document.createElement('div');
            actions.className = 'script-mark-row-buy';
            [1, 10, 100, 1000, 10000].forEach(quantity => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'mk-bulk-btn';
                button.textContent = quantity.toLocaleString('pt-BR');
                button.title = `Comprar ${quantity.toLocaleString('pt-BR')}× ${name}`;
                button.addEventListener('click', async event => {
                    event.preventDefault(); event.stopPropagation();
                    button.disabled = true;
                    try {
                        const currentGold = Math.max(0, parseGameNumber(mkWindow.querySelector('.mk-gold')?.textContent), Number(catalog.gold || 0));
                        const confirmed = await new Promise(resolve => showPurchaseConfirm({ name, quantity, unitPrice: Number(product.priceGold) || 0, currentGold }, resolve));
                        if (!confirmed) return;
                        const result = await buyFromMarkShop(product, ball ? 'ball' : 'item', quantity);
                        const gold = mkWindow.querySelector('.mk-gold');
                        if (gold && result.gold !== undefined) gold.textContent = `💲 ${Number(result.gold).toLocaleString('pt-BR')}`;
                        const owned = row.querySelector('.script-owned-qty');
                        if (owned) {
                            const serverCount = ball ? result.counts?.[String(product.id)] : result.inventory?.find?.(entry => String(entry.itemId) === String(product.id))?.quantity;
                            const current = parseGameNumber(owned.textContent);
                            owned.textContent = `${Number(serverCount ?? current + quantity).toLocaleString('pt-BR')}× ${tr('inStock')}`;
                        }
                        latestInventory = null; markCatalogPromise = null; ballCatalogPromise = null;
                        const confirmedStock = ball
                            ? Number((await loadBallCatalog()).counts?.[String(product.id)])
                            : Number((await requestFreshGameEvent('inventory', 'inv-get', { timeoutMs: 3500, attempts: 2 }))
                                .find(entry => String(entry.itemId) === String(product.id))?.quantity || 0);
                        const currentOwned = row.querySelector('.script-owned-qty');
                        if (currentOwned && Number.isFinite(confirmedStock)) {
                            currentOwned.textContent = `${confirmedStock.toLocaleString('pt-BR')}× ${tr('inStock')}`;
                        }
                        showWindowMessage(mkWindow, `Compra concluída: ${quantity.toLocaleString('pt-BR')}× ${name}`);
                    } catch (error) {
                        showWindowMessage(mkWindow, `Não foi possível concluir a compra: ${error.message}`, true);
                    } finally { button.disabled = false; }
                });
                actions.appendChild(button);
            });
            (row.querySelector('.mk-actions') || row).appendChild(actions);
        });
    }

    async function injectMarkProductIcons(mkWindow) {
        const buyTab = Array.from(mkWindow.querySelectorAll('.mk-tab'))
            .some(tab => tab.classList.contains('on') && /Comprar|Buy/i.test(tab.textContent));
        const rows = Array.from(mkWindow.querySelectorAll('.mk-row')).filter(row => row.querySelector('.mk-name'));
        if (!buyTab || !rows.length) return;
        let catalog;
        try { catalog = await loadMarkCatalog(); } catch { return; }
        rows.forEach(row => {
            if (row.querySelector('.script-mark-product-icon, .mk-ico, .mk-icon, img')) return;
            const name = row.querySelector('.mk-name')?.textContent?.trim();
            const product = catalog.balls?.find(item => item.name === name)
                || catalog.items?.find(item => item.name === name);
            if (!product) return;
            const iconSource = product.icon || product.iconUrl || product.image || product.sprite;
            if (!iconSource) return;
            const icon = document.createElement('img');
            icon.className = 'script-mark-product-icon';
            icon.src = normalizeGameItemIcon(iconSource);
            icon.alt = '';
            icon.addEventListener('error', () => icon.remove(), { once: true });
            const info = row.querySelector('.mk-info');
            if (info?.parentElement === row) row.insertBefore(icon, info);
            else row.querySelector('.mk-name')?.before(icon);
        });
    }

    async function injectMarkOwnedQuantities(mkWindow) {
        const buyTab = Array.from(mkWindow.querySelectorAll('.mk-tab'))
            .some(tab => tab.classList.contains('on') && /Comprar|Buy/i.test(tab.textContent));
        if (!buyTab || !mkWindow.querySelector('.mk-row') || mkWindow.dataset.scriptOwnedLoading === 'true') return;
        mkWindow.dataset.scriptOwnedLoading = 'true';

        let shouldRetry = false;
        try {
            let [inventory, ballsData, shopData] = await Promise.all([
                requestGameEvent('inventory', 'inv-get', latestInventory),
                loadBallCatalog(),
                loadMarkCatalog()
            ]);
            const inventoryAvailable = inventory.length > 0;
            shouldRetry = !inventoryAvailable;
            const itemCounts = new Map(inventory.map(entry => [String(entry.itemId), Number(entry.quantity) || 0]));

            mkWindow.querySelectorAll('.mk-row').forEach(row => {
                const name = row.querySelector('.mk-name')?.textContent?.trim();
                const info = row.querySelector('.mk-info');
                if (!name || !info) return;
                const ball = shopData.balls?.find(item => item.name === name);
                const item = shopData.items?.find(entry => entry.name === name);
                if (!ball && item && !inventoryAvailable) {
                    info.querySelector('.script-owned-qty')?.remove();
                    return;
                }
                const quantity = ball
                    ? Number(ballsData.counts?.[String(ball.id)] || 0)
                    : Number(itemCounts.get(String(item?.id)) || 0);

                let owned = info.querySelector('.script-owned-qty');
                if (!owned) {
                    owned = document.createElement('div');
                    owned.className = 'mk-meta script-owned-qty';
                    info.appendChild(owned);
                }
                const quantityText = `${quantity.toLocaleString(getGameLanguage() === 'pt' ? 'pt-BR' : 'en-US')}× ${tr('inStock')}`;
                if (owned.textContent !== quantityText) owned.textContent = quantityText;
            });
            if (inventoryAvailable) delete mkWindow.dataset.scriptOwnedRetries;
        } catch (error) {
            console.warn('Falha ao carregar quantidades do Mark:', error);
            shouldRetry = true;
        } finally {
            delete mkWindow.dataset.scriptOwnedLoading;
            if (shouldRetry && mkWindow.isConnected) {
                const retries = Number(mkWindow.dataset.scriptOwnedRetries || 0);
                if (retries < 5) {
                    mkWindow.dataset.scriptOwnedRetries = String(retries + 1);
                    setTimeout(() => injectMarkOwnedQuantities(mkWindow), 800);
                }
            }
        }
    }

    function showMarkModSettings(mkWindow) {
        const activateMarkSettings = () => {
            injectConfigTab();
            const configWindow = document.querySelector('.cfg-window');
            const modsTab = configWindow?.querySelector('.cfg-tab-mods');
            if (!modsTab || !configWindow.getClientRects().length) return false;
            modsTab.click();
            requestAnimationFrame(() => {
                const markSetting = configWindow.querySelector('.cfg-mark-quick-buy, .cfg-mark-quality-picker, .btn-mark-enhancements');
                const section = markSetting?.closest('.script-mod-category') || markSetting?.closest('.cfg-row');
                section?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            });
            return true;
        };
        const settingsButton = Array.from(document.querySelectorAll('button')).find(button => {
            if (button.closest('.mk-window, .cfg-window') || button.classList.contains('script-mark-settings')) return false;
            const accessibleText = `${button.textContent || ''} ${button.title || ''} ${button.getAttribute('aria-label') || ''}`.trim();
            return /configura|settings|ajustes|prefer[eê]ncias/i.test(accessibleText)
                || /^⚙(?:️)?$/.test(accessibleText)
                || button.matches('[class*="setting" i], [class*="config" i], [class*="gear" i]');
        });
        const closeButton = mkWindow.querySelector('.ball-head .cfg-x:not(.script-mark-settings), .mk-head .cfg-x:not(.script-mark-settings)');
        closeButton?.click();
        setTimeout(() => {
            const configWindow = document.querySelector('.cfg-window');
            if (!configWindow?.getClientRects().length) {
                settingsButton?.click();
                setTimeout(() => {
                    const menuItem = Array.from(document.querySelectorAll('button, .sel-item')).find(element => {
                        if (!element.getClientRects().length || element === settingsButton || element.closest('.cfg-window, .mk-window')) return false;
                        return /^(?:Configurações|Settings)$/i.test(element.textContent.trim());
                    });
                    menuItem?.click();
                }, 100);
            }
            let attempts = 0;
            const waitForSettings = setInterval(() => {
                attempts += 1;
                if (activateMarkSettings() || attempts >= 40) {
                    clearInterval(waitForSettings);
                    if (attempts >= 40) showScriptNotice('NÃ£o foi possÃ­vel abrir as configuraÃ§Ãµes do Mark.', { title: 'ConfiguraÃ§Ãµes', isError: true });
                }
            }, 50);
        }, 80);
    }

    function injectMarkSettingsButton(mkWindow) {
        const header = mkWindow.querySelector('.ball-head, .mk-head');
        if (!header || header.querySelector('.script-mark-settings')) return;
        const settingsButton = document.createElement('button');
        settingsButton.type = 'button';
        settingsButton.className = 'cfg-x script-mark-settings';
        settingsButton.textContent = '⚙️';
        settingsButton.title = 'ConfiguraÃ§Ãµes do Mark';
        settingsButton.setAttribute('aria-label', 'Abrir configuraÃ§Ãµes do Mark');
        settingsButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            showMarkModSettings(mkWindow);
        });
        const closeButton = header.querySelector('.cfg-x');
        if (closeButton) closeButton.before(settingsButton);
        else header.appendChild(settingsButton);
    }

    function injectShopEnhancements() {
        document.querySelectorAll('.script-market-window .script-mark-settings').forEach(button => button.remove());
        const mkWindow = findNativeMarkWindow();
        if (!mkWindow) return;

        injectMarkProductIcons(mkWindow);
        injectMarkBuyQuantities(mkWindow);
        injectMarkOwnedQuantities(mkWindow);
        injectMarkQualityMultiSelect(mkWindow);
        injectMarkSettingsButton(mkWindow);

        const isSellTab = !!Array.from(mkWindow.querySelectorAll('.mk-tab'))
            .find(t => t.classList.contains('on') && /\b(?:Sell|Vender)\b/i.test(t.textContent));
        if (isSellTab) {
            mkWindow.querySelectorAll('.mk-srow-head').forEach(row => {
                const itemName = row.querySelector('.mk-name')?.textContent?.trim();
                const nativeLock = row.querySelector('.mk-lock, [class*="lock" i][role="button"], button[aria-label*="lock" i]');
                if (!itemName || !nativeLock) return;
                const lockText = `${nativeLock.textContent || ''} ${nativeLock.title || ''} ${nativeLock.getAttribute('aria-label') || ''}`;
                const locked = row.classList.contains('locked') || nativeLock.classList.contains('on')
                    || /🔒|unlock|destravar|desbloquear/i.test(lockText);
                setNativeItemLock(itemName, locked);
            });
            const sellBar = mkWindow.querySelector('.mk-sellbar');
            if (sellBar && !sellBar.dataset.sellIntercepted) {
                let sellConfirmed = false;
                sellBar.addEventListener('click', (e) => {
                    const sellBtn = e.target.closest('button.mk-sell');
                    if (!sellBtn || sellBtn.disabled) return;

                    if (sellConfirmed) {
                        sellConfirmed = false;
                        return;
                    }

                    const confirmList = getSellConfirmItems();
                    const selectedToConfirm = [];
                    mkWindow.querySelectorAll('.mk-srow-head').forEach(row => {
                        const cb = row.querySelector('input.mk-check');
                        if (cb && cb.checked) {
                            const nameEl = row.querySelector('.mk-name');
                            const itemName = nameEl ? nameEl.textContent.trim() : '';
                            if (confirmList.includes(itemName)) {
                                selectedToConfirm.push(itemName);
                            }
                        }
                    });

                    if (selectedToConfirm.length > 0) {
                        e.stopImmediatePropagation();
                        e.preventDefault();
                        showSellConfirm(selectedToConfirm, (confirmed) => {
                            if (confirmed) {
                                sellConfirmed = true;
                                sellBtn.click();
                            }
                        });
                    }
                }, true);
                sellBar.dataset.sellIntercepted = 'true';
            }
        }

        const isPokeTab = !!Array.from(mkWindow.querySelectorAll('.mk-tab')).find(t => t.classList.contains('on') && t.textContent.includes('Pokémon'));
        if (isPokeTab) {
            const selectAllBtn = mkWindow.querySelector('button.mk-selall');
            if (selectAllBtn && !selectAllBtn.dataset.intercepted) {
                selectAllBtn.addEventListener('click', () => {
                    if (!isGuardLegendaryActive()) return;
                    let ticks = 0;
                    const interval = setInterval(() => {
                        mkWindow.querySelectorAll('.mk-srow-head').forEach(row => {
                            const rarity = getPokemonRarity(row);
                            const forbidden = ['lendária', 'mítica', 'divina'];
                            if (rarity && forbidden.some(r => rarity.includes(r))) {
                                const cb = row.querySelector('input.mk-check');
                                if (cb && cb.checked) cb.click();
                            }
                        });
                        ticks++;
                        if (ticks > 5) clearInterval(interval);
                    }, 20);
                });
                selectAllBtn.dataset.intercepted = 'true';
            }
        }
    }

    function injectDexEnhancements() {
        const dexWindow = document.querySelector('.dex-window');
        if (!dexWindow) return;

        const grid = dexWindow.querySelector('.dex-grid');
        if (!grid) {
            const stale = dexWindow.querySelector('.dex-script-controls');
            if (stale) stale.remove();
            return;
        }

        if (dexWindow.querySelector('.dex-script-controls')) {
            return;
        }
        loadCaughtPokedexData(true);

        const dexControls = dexWindow.querySelector('.dex-controls');
        if (!dexControls) return;

        const ftEnabled = isDexFastTravelActive();

        const huntableNames = new Set();
        if (globalHuntMarkerData.size > 0) {
            for (const marker of new Set(globalHuntMarkerData.values())) {
                const name = getMarkerName(marker);
                if (name) huntableNames.add(getCleanHuntName(name));
            }
        } else {
            for (const [name, data] of globalCreatureApiData.entries()) {
                if (data.hunts?.length || data.hunt || data.area || data.map || data.location || data.slug) {
                    huntableNames.add(name);
                }
            }
        }

        grid.querySelectorAll('.dex-cell').forEach(cell => {
            if (cell.querySelector('.dex-no-hunt-badge')) return;
            const nameEl = cell.querySelector('.dex-cell-name');
            if (!nameEl) return;
            const pokeName = nameEl.textContent.trim().toLowerCase();
            const hasData = globalCreatureApiData.has(pokeName);
            if (hasData && huntableNames.size > 0 && !huntableNames.has(pokeName)) {
                const badge = document.createElement('span');
                badge.className = 'dex-no-hunt-badge';
                badge.textContent = '✕';
                badge.title = 'Sem hunt disponível';
                badge.style.cssText = 'position:absolute;top:2px;right:2px;background:#e53e3e;color:#fff;border-radius:50%;width:14px;height:14px;font-size:9px;display:flex;align-items:center;justify-content:center;line-height:1;font-weight:bold;pointer-events:none;';
                cell.style.position = 'relative';
                cell.appendChild(badge);
            }
        });

        const bar = document.createElement('div');
        bar.className = 'dex-script-controls';
        bar.innerHTML = ftEnabled ? '<label class="dex-ft-label"><input type="checkbox" class="dex-ft-check"> ⚡ Fast Travel</label>' : '';
        dexControls.after(bar);

        const filterBtns = bar.querySelectorAll('.dex-fbtn[data-filter]');
        const sortBtn = bar.querySelector('.dex-fbtn[data-filter="sort-value"]');

        let currentFilter = 'all';
        let sortedByValue = false;
        let originalOrder = null;

        function applyFilter() {
            const cells = grid.querySelectorAll('.dex-cell');
            cells.forEach(cell => {
                const isCaught = cell.classList.contains('caught');
                const isClaimable = cell.classList.contains('claimable');
                if (currentFilter === 'all') {
                    cell.classList.remove('dex-hidden');
                } else if (currentFilter === 'caught') {
                    cell.classList.toggle('dex-hidden', !isCaught);
                } else if (currentFilter === 'notcaught') {
                    cell.classList.toggle('dex-hidden', isCaught);
                } else if (currentFilter === 'claimable') {
                    cell.classList.toggle('dex-hidden', !isClaimable);
                }
            });
        }

        function getPokeValue(name) {
            const cleanName = name.toLowerCase().trim();
            const noHunt = huntableNames.size > 0 && !huntableNames.has(cleanName);
            if (globalCreatureApiData.has(cleanName)) {
                const pokeObj = globalCreatureApiData.get(cleanName);
                const possiblePriceKeys = ['sellValue', 'priceNpc', 'sell', 'sellsFor', 'price', 'value', 'gold', 'money', 'cost', 'reward'];
                for (const key of possiblePriceKeys) {
                    if (pokeObj[key] !== undefined && pokeObj[key] !== null && pokeObj[key] !== '') {
                        const parsed = parseGameNumber(pokeObj[key]);
                        if (parsed > 0) return noHunt ? 99999999 : parsed;
                    }
                }
            }
            return 999999;
        }

        function sortByValue() {
            if (!originalOrder) originalOrder = Array.from(grid.children);
            const cells = Array.from(grid.querySelectorAll('.dex-cell'));
            cells.sort((a, b) => {
                const nameA = a.querySelector('.dex-cell-name')?.textContent || '';
                const nameB = b.querySelector('.dex-cell-name')?.textContent || '';
                return getPokeValue(nameA) - getPokeValue(nameB);
            });
            cells.forEach(c => grid.appendChild(c));
            sortedByValue = true;
            setDexSortedByValue(true);
        }

        function restoreOrder() {
            if (originalOrder) {
                originalOrder.forEach(c => grid.appendChild(c));
                sortedByValue = false;
                setDexSortedByValue(false);
            }
        }

        if (sortedByValue) sortByValue();

        filterBtns.forEach(b => b.classList.remove('on'));
        const activeBtn = bar.querySelector(`.dex-fbtn[data-filter="${currentFilter}"]`);
        if (activeBtn) activeBtn.classList.add('on');
        if (currentFilter === 'notcaught' && sortBtn) sortBtn.style.display = '';
        applyFilter();

        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const filter = btn.dataset.filter;
                if (filter === 'sort-value') {
                    if (sortedByValue) {
                        restoreOrder();
                        btn.classList.remove('on');
                    } else {
                        sortByValue();
                        btn.classList.add('on');
                    }
                    applyFilter();
                    return;
                }
                currentFilter = filter;
                setDexFilter(filter);
                filterBtns.forEach(b => {
                    if (b.dataset.filter !== 'sort-value') b.classList.remove('on');
                });
                btn.classList.add('on');

                if (filter === 'notcaught') {
                    sortBtn.style.display = '';
                } else {
                    sortBtn.style.display = 'none';
                    if (sortedByValue) {
                        restoreOrder();
                        sortBtn.classList.remove('on');
                    }
                }
                applyFilter();
            });
        });

        const ftCheck = bar.querySelector('.dex-ft-check');
        if (ftCheck && !grid.dataset.fastTravelIntercepted) {
            grid.addEventListener('click', (e) => {
                const currentFtCheck = dexWindow.querySelector('.dex-ft-check');
                if (!currentFtCheck?.checked) return;
                const cell = e.target.closest('.dex-cell');
                if (!cell) return;
                e.stopPropagation();
                e.preventDefault();
                const pokeName = cell.querySelector('.dex-cell-name')?.textContent?.trim();
                if (!pokeName) return;
                teleportToTarget(pokeName);
            }, true);
            grid.dataset.fastTravelIntercepted = 'true';
        }
    }

    let lastHuntSnapshot = null;
    let currentHuntSnapshot = null;
    let lastCatchTimestamp = null;
    let ballsAtLastCatch = 0;
    let capturesCount = 0;
    let lastHuntStartTime = null;
    let currentHuntStartTime = Date.now();
    let huntHistory = readStoredJSON(STORAGE_HA_HISTORY, []);
    if (!Array.isArray(huntHistory)) huntHistory = [];

    function parseHuntDuration(text) {
        const value = String(text || '');
        if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value.trim())) {
            return value.trim().split(':').map(Number).reduce((total, part) => (total * 60) + part, 0);
        }
        const hours = Number(value.match(/(\d+)\s*h/)?.[1] || 0);
        const minutes = Number(value.match(/(\d+)\s*m/)?.[1] || 0);
        const seconds = Number(value.match(/(\d+)\s*s/)?.[1] || 0);
        return (hours * 3600) + (minutes * 60) + seconds;
    }

    function getCurrentHuntLocation() {
        const location = document.querySelector('.phud-tloc')?.textContent?.trim() || '';
        const parts = location.split(/[·•]/).map(part => part.trim()).filter(Boolean);
        return parts.at(-1) || location || '';
    }

    function saveHuntSession(snapshot, startedAt) {
        if (!snapshot || Date.now() - startedAt < 3000 || (!snapshot.defeated && !snapshot.xpGained && !snapshot.balance)) return false;
        huntHistory.unshift({ ...snapshot, startedAt, endedAt: Date.now() });
        huntHistory = huntHistory.slice(0, 20);
        localStorage.setItem(STORAGE_HA_HISTORY, JSON.stringify(huntHistory));
        return true;
    }

    function formatNumber(num) {
        return new Intl.NumberFormat('pt-BR').format(num);
    }

    function getPokemonQualityInfo(multiplier) {
        const value = Number(multiplier);
        if (!Number.isFinite(value)) return null;
        if (value < 1.0) return { label: 'Fraca', color: '#9e9e9e' };
        if (value < 1.1) return { label: 'Comum', color: '#a8a8a8' };
        if (value < 1.3) return { label: 'Incomum', color: '#5ed7b9' };
        if (value < 1.5) return { label: 'Rara', color: '#69b7ff' };
        if (value < 1.7) return { label: 'Épica', color: '#d985ff' };
        if (value < 2.0) return { label: 'Lendária', color: '#f1c644' };
        if (value < 3.0) return { label: 'Mítica', color: '#ff6680' };
        if (value < 4.0) return { label: 'Anciã', color: '#ff9800' };
        return { label: 'Divina', color: '#00bcd4' };
    }

    function formatPokemonQuality(multiplier) {
        const info = getPokemonQualityInfo(multiplier);
        const value = Number(multiplier);
        return info ? `${info.label} ×${value.toFixed(2)}` : null;
    }

    function formatPokemonQualityWithPotential(multiplier, ivTotal, isShiny = false) {
        const quality = formatPokemonQuality(multiplier);
        const potential = getPokemonPotentialPercent(multiplier, ivTotal, isShiny);
        if (!quality) return 'Qualidade —';
        const info = getPokemonQualityInfo(multiplier);
        return `${info.label}${potential === null ? '' : ` ${potential}%`} ×${Number(multiplier).toFixed(2)}`;
    }

    function getCaptureIvTotal(capture, row) {
        const directValues = [capture?.ivTotal, capture?.totalIv, capture?.iv, capture?.growth];
        for (const candidate of directValues) {
            if (Number.isFinite(Number(candidate))) return Number(candidate);
            if (candidate && typeof candidate === 'object') {
                const total = Object.values(candidate).reduce((sum, value) => sum + (Number(value) || 0), 0);
                if (total > 0) return total;
            }
        }

        const ivText = row?.textContent?.match(/\bIV\s*:?\s*(\d+(?:[.,]\d+)?)\s*(?:\/\s*192)?/i)?.[1];
        return ivText ? Number(ivText.replace(',', '.')) : null;
    }

    const WILD_QUALITY_CEILING = 1.8;
    const SPECIAL_QUALITY_CEILING = 4.0;
    function getPokemonQualityCeiling(multiplier, isShiny) {
        const quality = Number(multiplier);
        return (isShiny || quality > WILD_QUALITY_CEILING) ? SPECIAL_QUALITY_CEILING : WILD_QUALITY_CEILING;
    }

    const POTENTIAL_QUALITY_WEIGHT = 0.75;
    function getPokemonPotentialPercent(multiplier, ivTotal, isShiny = false) {
        if (!preferenceEnabled(STORAGE_SHOW_QUALITY_POTENTIAL)) return null;
        const quality = Number(multiplier);
        const iv = Number(ivTotal);
        if (!Number.isFinite(quality) || !Number.isFinite(iv)) return null;
        const qualityCeiling = getPokemonQualityCeiling(quality, isShiny);
        const normalizedQuality = (Math.min(qualityCeiling, Math.max(0.8, quality)) - 0.8) / (qualityCeiling - 0.8);
        const normalizedIv = Math.min(192, Math.max(0, iv)) / 192;
        const weighted = normalizedQuality * POTENTIAL_QUALITY_WEIGHT + normalizedIv * (1 - POTENTIAL_QUALITY_WEIGHT);
        return Math.min(100, Math.max(0, Math.round(weighted * 100)));
    }

    function getPokemonQualityTitle(multiplier, ivTotal, isShiny = false) {
        const value = Number(multiplier);
        const formatted = formatPokemonQuality(value);
        const potential = getPokemonPotentialPercent(value, ivTotal, isShiny);
        if (!formatted) return '';
        const qualityCeiling = getPokemonQualityCeiling(value, isShiny);
        return potential === null
            ? `Qualidade: ${formatted}`
            : `Potencial: ${potential}% (IV ${Number(ivTotal).toFixed(1)}/192 e qualidade ${Number(multiplier).toFixed(2)}×; máximo: 192 IV e ×${qualityCeiling.toFixed(1)})`;
    }

    function normalizePartyPokemonName(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\bshiny\b/gi, '')
            .replace(/[^a-z0-9]/gi, '')
            .toLowerCase();
    }

    function enhancePartyQuality(pokemonList = latestPokemon) {
        const buttons = Array.from(document.querySelectorAll('div.phud-party > button.phud-mon'));
        if (!buttons.length) return;

        const teamPokemon = Array.isArray(pokemonList)
            ? pokemonList.filter(pokemon => pokemon?.team).sort((a, b) => Number(a.slot ?? 99) - Number(b.slot ?? 99))
            : [];

        if (!teamPokemon.length) return;

        buttons.forEach((button, index) => {
            const nameElement = button.querySelector('.phud-mon-name, .phud-name, [class*="name"]') || button;
            const visibleName = normalizePartyPokemonName(nameElement.textContent);
            const pokemon = teamPokemon.find(entry => normalizePartyPokemonName(entry.name) === visibleName) || teamPokemon[index];
            const oldBadge = button.querySelector('.script-party-quality');
            const ivTotal = getCaptureIvTotal(pokemon, null);
            const qualityInfo = getPokemonQualityInfo(pokemon?.quality);
            const potential = getPokemonPotentialPercent(pokemon?.quality, ivTotal, pokemon?.shiny);

            if (!pokemon || !qualityInfo || potential === null) {
                oldBadge?.remove();
                return;
            }

            const badge = oldBadge || document.createElement('span');
            badge.className = 'script-party-quality';
            badge.textContent = `${potential}%`;
            badge.style.color = qualityInfo.color;
            badge.title = getPokemonQualityTitle(pokemon.quality, ivTotal, pokemon?.shiny);
            if (!oldBadge) nameElement.appendChild(badge);
        });
    }

    function refreshHuntAnalyzerGameRender() {}

    function showCompareModal() {
        const curr = currentHuntSnapshot || { defeated: 0, timeText: '0s', balance: 0, balHour: 0, xpHour: 0, killsHour: 0, xpGained: 0, locName: 'Nenhuma' };
        const last = lastHuntSnapshot || huntHistory[0] || { defeated: 0, timeText: '0s', balance: 0, balHour: 0, xpHour: 0, killsHour: 0, xpGained: 0, locName: 'Nenhuma' };

        const cmp = (a, b) => {
            if (a > b) return ['ha-compare-winner', 'ha-compare-loser'];
            if (b > a) return ['ha-compare-loser', 'ha-compare-winner'];
            return ['', ''];
        };

        const formatTitle = (ts, loc) => {
            let res = loc ? loc : 'Hunt';
            if (ts) {
                const d = new Date(ts);
                res += ` (${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')})`;
            }
            return res;
        };
        const lastTitle = formatTitle(lastHuntStartTime || last.startedAt, last.locName);
        const currTitle = formatTitle(currentHuntStartTime, curr.locName);

        const [balLast, balCurr] = cmp(last.balance, curr.balance);
        const [balhLast, balhCurr] = cmp(last.balHour, curr.balHour);
        const [xpLast, xpCurr] = cmp(last.xpHour, curr.xpHour);
        const [killsLast, killsCurr] = cmp(last.killsHour, curr.killsHour);
        const [xpgLast, xpgCurr] = cmp(last.xpGained, curr.xpGained);

        const formatBal = (val) => val < 0 ? `-$${formatNumber(Math.abs(val))}` : `$${formatNumber(val)}`;

        const backdrop = document.createElement('div');
        backdrop.className = 'ha-compare-backdrop';
        backdrop.innerHTML = `
            <div class="ha-window ha-compare-modal" style="position: relative; box-shadow: 0 12px 32px rgba(0,0,0,0.8);">
                <div class="ha-title">
                    <span>⚖️ Comparação de Hunts</span>
                    <button class="ha-x ha-compare-close" aria-label="Close" type="button">×</button>
                </div>
                <div style="padding: 12px;">
                    <table class="ha-compare-table">
                        <tr><th>Métrica</th><th>${escapeHTML(lastTitle)}</th><th>${escapeHTML(currTitle)}</th></tr>
                        <tr><td>💰 Balance Total</td><td class="${balLast}">${formatBal(last.balance)}</td><td class="${balCurr}">${formatBal(curr.balance)}</td></tr>
                        <tr><td>📉 Balance/h</td><td class="${balhLast}">${formatBal(last.balHour)}</td><td class="${balhCurr}">${formatBal(curr.balHour)}</td></tr>
                        <tr><td>🌟 XP Gained</td><td class="${xpgLast}">${formatNumber(last.xpGained)}</td><td class="${xpgCurr}">${formatNumber(curr.xpGained)}</td></tr>
                        <tr><td>✨ XP/h</td><td class="${xpLast}">${formatNumber(last.xpHour)}</td><td class="${xpCurr}">${formatNumber(curr.xpHour)}</td></tr>
                        <tr><td>⚔️ Kills/h</td><td class="${killsLast}">${formatNumber(last.killsHour)}</td><td class="${killsCurr}">${formatNumber(curr.killsHour)}</td></tr>
                        <tr><td>⏱️ Tempo</td><td>${last.timeText}</td><td>${curr.timeText}</td></tr>
                        <tr><td>💀 Defeated</td><td>${last.defeated}</td><td>${curr.defeated}</td></tr>
                    </table>
                    <div style="margin-top:12px;border-top:1px solid #263b4c;padding-top:10px;">
                        <div style="display:flex;align-items:center;gap:8px;">
                            <b style="color:#dce7f1;flex:1;">Histórico recente</b>
                            <button class="ha-sbtn ha-history-clear" type="button">Limpar histórico</button>
                        </div>
                        <div class="ha-history-list" style="display:grid;gap:6px;margin-top:8px;max-height:150px;overflow:auto;">
                            ${huntHistory.length ? huntHistory.slice(0, 10).map(session => `
                                <div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;background:#101d27;border-radius:6px;padding:7px 9px;color:#aebdca;font-size:12px;">
                                    <span>${escapeHTML(session.locName || 'Hunt')}</span>
                                    <span>${formatBal(session.balance || 0)}</span>
                                    <span>${formatNumber(session.xpGained || 0)} XP</span>
                                </div>
                            `).join('') : '<span style="color:#718096;font-size:12px;">Nenhuma sessão concluída ainda.</span>'}
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        backdrop.querySelector('.ha-history-clear').addEventListener('click', async () => {
            if (!await showScriptConfirm('Apagar todo o histórico salvo do Hunt Analyzer?', {
                title: 'Limpar histórico',
                confirmLabel: 'Apagar'
            })) return;
            huntHistory = [];
            lastHuntSnapshot = null;
            localStorage.removeItem(STORAGE_HA_HISTORY);
            backdrop.querySelector('.ha-history-list').innerHTML = '<span style="color:#718096;font-size:12px;">Nenhuma sessão concluída ainda.</span>';
        });

        let isDragging = false, startX = 0, startY = 0, initialLeft = 0, initialTop = 0;
        const modal = backdrop.querySelector('.ha-compare-modal');
        const titleBar = modal.querySelector('.ha-title');

        titleBar.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            const rect = modal.getBoundingClientRect();
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            initialLeft = rect.left;
            initialTop = rect.top;
            modal.style.setProperty('left', `${rect.left}px`, 'important');
            modal.style.setProperty('top', `${rect.top}px`, 'important');
            modal.style.transform = 'none';
            titleBar.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        });
        const handlePointerMove = e => {
            if (!isDragging) return;
            const maxLeft = Math.max(0, window.innerWidth - modal.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - modal.offsetHeight);
            modal.style.setProperty('left', `${Math.min(maxLeft, Math.max(0, initialLeft + e.clientX - startX))}px`, 'important');
            modal.style.setProperty('top', `${Math.min(maxTop, Math.max(0, initialTop + e.clientY - startY))}px`, 'important');
        };
        const handlePointerUp = () => { isDragging = false; };
        document.addEventListener('pointermove', handlePointerMove);
        document.addEventListener('pointerup', handlePointerUp);

        backdrop.querySelector('.ha-compare-close').addEventListener('click', () => {
            document.removeEventListener('pointermove', handlePointerMove);
            document.removeEventListener('pointerup', handlePointerUp);
            backdrop.remove();
        });
    }

    let lastHuntAnalyzerTrackAt = 0;
    const HUNT_ANALYZER_TRACK_INTERVAL_MS = 1000;
    function trackHuntAnalyzer() {
        const haWindow = document.querySelector('.ha-window:not(.ha-compare-modal)');
        if (!haWindow) return;
        if (Date.now() - lastHuntAnalyzerTrackAt < HUNT_ANALYZER_TRACK_INTERVAL_MS) return;
        lastHuntAnalyzerTrackAt = Date.now();

        const getCardVal = (idx) => {
            const card = haWindow.querySelectorAll('.ha-card b')[idx];
            return card ? parseInt(card.textContent.replace(/[^0-9]/g, ''), 10) || 0 : 0;
        };
        const defeated = getCardVal(0);
        const timeText = haWindow.querySelectorAll('.ha-card b')[1]?.textContent || '0s';
        const xpGained = getCardVal(2);
        if (lastAnalyzerXp === null || xpGained !== lastAnalyzerXp) {
            lastAnalyzerXp = xpGained;
            lastAnalyzerXpChangeAt = Date.now();
        }

        const balanceNode = haWindow.querySelector('.ha-balance b');
        let balance = 0;
        if (balanceNode) {
            balance = parseInt(balanceNode.textContent.replace(/−/g, '-').replace(/[.]/g, '').replace(/[^0-9-]/g, ''), 10) || 0;
        }

        const catchCard = haWindow.querySelector('.ha-catch b');
        const currentCatch = catchCard ? parseInt(catchCard.textContent.replace(/[^0-9]/g, ''), 10) || 0 : 0;

        let currentBalls = 0;
        const supplyCard = haWindow.querySelector('.ha-supply small');
        if (supplyCard) {
            const match = supplyCard.textContent.match(/(\d+)\s+balls/);
            if (match) currentBalls = parseInt(match[1], 10);
        }

        const locName = getCurrentHuntLocation() || currentHuntSnapshot?.locName || '';
        const durationSeconds = parseHuntDuration(timeText);
        const locationChanged = Boolean(
            currentHuntSnapshot?.locName && locName && currentHuntSnapshot.locName !== locName
        );
        const countersReset = Boolean(
            currentHuntSnapshot && (
                defeated < currentHuntSnapshot.defeated ||
                durationSeconds < (currentHuntSnapshot.durationSeconds || 0)
            )
        );
        const isReset = locationChanged || countersReset;

        if (isReset) {
            const completedSnapshot = { ...currentHuntSnapshot };
            if (saveHuntSession(completedSnapshot, currentHuntStartTime)) {
                lastHuntSnapshot = completedSnapshot;
            }
            capturesCount = 0;
            lastCatchTimestamp = null;
            ballsAtLastCatch = 0;
            lastHuntStartTime = currentHuntStartTime;
            currentHuntStartTime = Date.now();
        }

        if (!currentHuntSnapshot || isReset) {
            capturesCount = currentCatch;
        } else if (currentCatch > capturesCount) {
            capturesCount = currentCatch;
            lastCatchTimestamp = Date.now();
            ballsAtLastCatch = currentBalls;
        }

        const ratesNode = haWindow.querySelector('.ha-rates');
        let balHour = 0, xpHour = 0, killsHour = 0;
        if (ratesNode) {
            const spans = ratesNode.querySelectorAll('span:not(.ha-catch-stats)');
            if (spans[0]) balHour = parseInt(spans[0].textContent.replace(/−/g, '-').replace(/[.]/g, '').replace(/[^0-9-]/g, ''), 10) || 0;
            if (spans[1]) xpHour = parseInt(spans[1].textContent.replace(/[.]/g, '').replace(/[^0-9]/g, ''), 10) || 0;
            if (spans[2]) killsHour = parseInt(spans[2].textContent.replace(/[.]/g, '').replace(/[^0-9]/g, ''), 10) || 0;

            let catchStats = ratesNode.querySelector('.ha-catch-stats');
            if (!catchStats) {
                catchStats = document.createElement('span');
                catchStats.className = 'ha-rate ha-catch-stats';
                ratesNode.appendChild(catchStats);
            }
            if (lastCatchTimestamp) {
                const diffMs = Date.now() - lastCatchTimestamp;
                const diffM = Math.floor(diffMs / 60000);
                const timeStr = diffM > 0 ? `há ${diffM}m` : 'agora';
                const dateStr = new Date(lastCatchTimestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                const ballsSpent = Math.max(0, ballsAtLastCatch - currentBalls);
                const newText = `🔴 Último catch: ${dateStr} (${timeStr}) • ${ballsSpent} balls`;
                if (catchStats.textContent !== newText) {
                    catchStats.textContent = newText;
                }
                catchStats.classList.remove('hidden');
            } else {
                const newText = `🔴 Nenhum catch nesta hunt`;
                if (catchStats.textContent !== newText) {
                    catchStats.textContent = newText;
                }
                catchStats.classList.remove('hidden');
            }
        }

        const snapshot = { defeated, timeText, durationSeconds, balance, balHour, xpHour, killsHour, xpGained, locName };
        currentHuntSnapshot = snapshot;

        const oldToggle = haWindow.querySelector('.ha-title .ha-btn-toggle-view');
        if (oldToggle) oldToggle.remove();

        if (!haWindow.dataset.haInitialized) {
            if (isHaCompact()) haWindow.classList.add('ha-compact');
            haWindow.dataset.haInitialized = 'true';
        }

        const drops = haWindow.querySelector('.ha-drops');
        if (drops && !haWindow.dataset.haDropsInit) {
            if (isHaDropsVisible()) drops.classList.add('show-drops');
            haWindow.dataset.haDropsInit = 'true';
        }

        let actionArea = haWindow.querySelector('.ha-script-actions');
        let isNewActionArea = false;
        if (!actionArea) {
            actionArea = document.createElement('div');
            actionArea.className = 'ha-script-actions';
            isNewActionArea = true;

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'ha-sbtn btn-toggle-view';
            toggleBtn.innerHTML = haWindow.classList.contains('ha-compact') ? '⤢ Expandir' : '⤡ Reduzir';
            toggleBtn.type = 'button';
            toggleBtn.addEventListener('click', () => {
                const isCompact = haWindow.classList.toggle('ha-compact');
                toggleBtn.innerHTML = isCompact ? '⤢ Expandir' : '⤡ Reduzir';
                setHaCompact(isCompact);
            });

            const dropBtn = document.createElement('button');
            dropBtn.className = 'ha-sbtn btn-show-drops';
            dropBtn.innerHTML = '📦 Drops';
            dropBtn.type = 'button';
            dropBtn.addEventListener('click', () => {
                const dropsEl = haWindow.querySelector('.ha-drops');
                if (dropsEl) {
                    const visible = dropsEl.classList.toggle('show-drops');
                    setHaDropsVisible(visible);
                }
            });

            const compareBtn = document.createElement('button');
            compareBtn.className = 'ha-sbtn btn-compare';
            compareBtn.innerHTML = '⚖️ Comparar';
            compareBtn.type = 'button';
            compareBtn.addEventListener('click', showCompareModal);

            actionArea.appendChild(toggleBtn);
            actionArea.appendChild(dropBtn);
            if (preferenceEnabled(STORAGE_COMPARE_WINDOW)) actionArea.appendChild(compareBtn);
        }
        if (!preferenceEnabled(STORAGE_COMPARE_WINDOW)) actionArea.querySelector('.btn-compare')?.remove();

        const haTitle = haWindow.querySelector(':scope > .ha-title, :scope > h3, :scope > .ha-head, :scope > .ha-header')
            || haWindow.querySelector('.ha-title, h3, .ha-head, .ha-header');
        if (haTitle) {
            if (haTitle.nextElementSibling !== actionArea) haTitle.after(actionArea);
        } else if (isNewActionArea) {
            haWindow.prepend(actionArea);
        }
    }

    function enhanceInventoryWindow() {
        const inventoryWindow = document.querySelector('.inv-window');
        if (!inventoryWindow) return;
        inventoryWindow.classList.add('script-resizable-inventory');

        const namedBackdrop = inventoryWindow.closest(
            '.win-backdrop, .modal-backdrop, .window-backdrop, .overlay, [class*="backdrop"]'
        );
        if (namedBackdrop && namedBackdrop !== inventoryWindow) {
            namedBackdrop.classList.add('script-inventory-backdrop');
            return;
        }

        let ancestor = inventoryWindow.parentElement;
        while (ancestor && ancestor !== document.body) {
            const style = getComputedStyle(ancestor);
            const rect = ancestor.getBoundingClientRect();
            if (style.position === 'fixed' && rect.width >= innerWidth * 0.8 && rect.height >= innerHeight * 0.8) {
                ancestor.classList.add('script-inventory-backdrop');
                break;
            }
            ancestor = ancestor.parentElement;
        }
    }

    function findCaptureLogWindow() {
        const nativeWindow = document.querySelector('.clog-window');
        if (nativeWindow) return nativeWindow;
        if (!document.querySelector('.clog-row')) return null;
        const titlePattern = /(?:log\s*de\s*capturas|capture\s*log)/i;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let titleNode = null;
        while (walker.nextNode()) {
            if (titlePattern.test(walker.currentNode.nodeValue || '')) {
                titleNode = walker.currentNode;
                break;
            }
        }
        if (!titleNode) return null;

        const tooBig = el => el.classList.contains('game-root') || el.querySelector('.game-canvas-host, .game-dock');

        let element = titleNode.parentElement;
        while (element && element !== document.body) {
            if (tooBig(element)) return null;
            const text = element.textContent || '';
            if (/\bIV\s*:?\s*\d+\s*\/\s*\d+/i.test(text) && element.querySelector('button')) return element;
            element = element.parentElement;
        }
        const fallback = titleNode.parentElement?.closest('.win-window, .prof-window, [role="dialog"]') || null;
        return fallback && !tooBig(fallback) ? fallback : null;
    }

    let captureLogEnhancementPromise = null;
    async function enhanceCaptureLog() {
        const captureWindow = findCaptureLogWindow();
        if (!captureWindow) return;
        captureWindow.classList.add('script-capture-log-window');
        const rows = Array.from(captureWindow.querySelectorAll('.clog-row'));
        if (!rows.length || rows.every(row => row.dataset.scriptQualityLoaded === 'true')) return;
        if (captureLogEnhancementPromise) return captureLogEnhancementPromise;

        const activeTab = captureWindow.querySelector('.clog-tab.on')?.textContent?.toLowerCase() || '';
        const filter = /shiny/.test(activeTab) ? 'shiny' : /norma/.test(activeTab) ? 'normal' : 'all';
        captureLogEnhancementPromise = gameApiRequest(`/api/game/capture-log?filter=${filter}`)
            .then(payload => {
                const captures = Array.isArray(payload?.rows) ? payload.rows : [];
                Array.from(captureWindow.querySelectorAll('.clog-row')).forEach((row, index) => {
                    const capture = captures[index];
                    const level = row.querySelector('.clog-lvl');
                    const quality = Number(capture?.quality);
                    const qualityInfo = getPokemonQualityInfo(quality);
                    if (!level || !qualityInfo) return;
                    const ivTotal = getCaptureIvTotal(capture, row);
                    const isShiny = capture?.shiny ?? (filter === 'shiny');
                    const potential = getPokemonPotentialPercent(quality, ivTotal, isShiny);
                    const ivText = Number.isFinite(ivTotal) ? ` IV ${ivTotal}/192` : '';
                    const potentialText = potential !== null ? ` (${potential}%)` : '';
                    level.textContent = `${formatPokemonQuality(quality)}${ivText}${potentialText}`;
                    level.style.color = qualityInfo.color;
                    level.title = getPokemonQualityTitle(quality, ivTotal, isShiny);
                    level.classList.add('script-quality-badge');
                    const meta = row.querySelector('.clog-meta');
                    if (meta?.innerText?.length) meta.innerHTML = '';
                    row.dataset.scriptQualityLoaded = 'true';
                });
            })
            .catch(error => console.error('Falha ao carregar a qualidade do Log de Capturas:', error))
            .finally(() => { captureLogEnhancementPromise = null; });
        return captureLogEnhancementPromise;
    }

    function enhanceNativeGlobalMarketQuality() {
        const metaCells = document.querySelectorAll('.mkt2-trow.clickable .mkt2-tc--meta');
        if (!metaCells.length) return;
        if (!preferenceEnabled(STORAGE_SHOW_QUALITY_POTENTIAL)) {
            metaCells.forEach(meta => meta.querySelector('.script-gm-potential')?.remove());
            return;
        }
        metaCells.forEach(meta => {
            const qualitySpan = meta.querySelector('span[style*="color"]');
            const oldBadge = qualitySpan?.querySelector('.script-gm-potential');
            const rawQualityText = qualitySpan
                ? Array.from(qualitySpan.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('')
                : '';
            const qualityMatch = rawQualityText.match(/(\d+(?:[.,]\d+)?)\s*$/);
            const ivMatch = meta.textContent.match(/IV\s*(\d+)/i);
            if (!qualitySpan || !qualityMatch || !ivMatch) { oldBadge?.remove(); return; }
            const quality = Number(qualityMatch[1].replace(',', '.'));
            const ivTotal = Number(ivMatch[1]);
            const nameText = meta.closest('.mkt2-trow')?.querySelector('.mkt2-tc--name')?.textContent || '';
            const isShiny = /^\s*shiny\b/i.test(nameText);
            const potential = getPokemonPotentialPercent(quality, ivTotal, isShiny);
            if (potential === null) { oldBadge?.remove(); return; }
            const badgeText = ` (${potential}%)`;
            if (oldBadge) {
                if (oldBadge.textContent !== badgeText) oldBadge.textContent = badgeText;
                return;
            }
            const badge = document.createElement('span');
            badge.className = 'script-gm-potential';
            badge.style.cssText = `font-weight:800;color:${qualitySpan.style.color};`;
            badge.textContent = badgeText;
            qualitySpan.appendChild(badge);
        });
    }

    function findQuestsWindow() {
        const titlePattern = /quests?\s*&?\s*tasks?|tasks?\s*&?\s*dailys?/i;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let titleNode = null;
        while (walker.nextNode()) {
            if (titlePattern.test(walker.currentNode.nodeValue || '')) {
                titleNode = walker.currentNode;
                break;
            }
        }
        if (!titleNode) return null;

        const tooBig = el => el.classList.contains('game-root') || el.querySelector('.game-canvas-host, .game-dock');
        let element = titleNode.parentElement;
        while (element && element !== document.body) {
            if (tooBig(element)) return null;
            if (/\d+\s*\/\s*\d+/.test(element.textContent || '') && element.querySelectorAll('*').length > 5) return element;
            element = element.parentElement;
        }
        return null;
    }

    function getQuestTaskRows(questsWindow) {
        return Array.from(questsWindow.querySelectorAll('*')).filter(element => {
            const text = element.textContent || '';
            if (!/\d+\s*\/\s*\d+/.test(text) || !/derrotar|capturar|defeat|catch/i.test(text)) return false;
            return !Array.from(element.children).some(child => {
                const childText = child.textContent || '';
                return /\d+\s*\/\s*\d+/.test(childText) && /derrotar|capturar|defeat|catch/i.test(childText);
            });
        });
    }

    function getQuestPokemonName(row) {
        const leaves = Array.from(row.querySelectorAll('*')).filter(element => !element.children.length);
        for (const element of leaves) {
            const text = element.textContent.trim();
            if (!text || /derrotar|capturar|defeat|catch|faltam|remaining|\d+\s*\/\s*\d+/i.test(text)) continue;
            const clean = normalizePokemonName(text);
            if (POKEMON_TYPES[clean] || globalCreatureApiData.has(clean) || globalHuntMarkerData.has(clean)) return text;
        }
        return null;
    }

    function injectQuestHuntButtons() {
        const questsWindow = findQuestsWindow();
        if (!questsWindow) return;

        getQuestTaskRows(questsWindow).forEach(row => {
            if (row.querySelector('.script-quest-tp-btn')) return;
            const pokemonName = getQuestPokemonName(row);
            if (!pokemonName) return;

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'mk-bulk-btn script-quest-tp-btn';
            button.textContent = '\u{1F5FA}\uFE0F Ir para a hunt';
            button.title = `Teleportar para a hunt de ${pokemonName}`;
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                teleportToTarget(pokemonName);
            });
            row.appendChild(button);
        });
    }

    let domCheckTimeout = null;
    const observer = new MutationObserver(() => {
        if (domCheckTimeout) return;
        domCheckTimeout = setTimeout(() => {
            domCheckTimeout = null;

            injectQuickTPButton();
            if (document.querySelector('.cfg-window')) injectConfigTab();
            applyChatState();
            suppressHuntServiceIcons();
            if (findNativeMarkWindow() && isMarkEnhancementsActive()) injectShopEnhancements();
            if (document.querySelector('.ball-window')) injectHuntBallEnhancements(document.querySelector('.ball-window'));
            if (document.querySelector('.dex-window')) injectDexEnhancements();
            if (document.querySelector('.ha-window:not(.ha-compare-modal)')) trackHuntAnalyzer();
            if (document.querySelector('.inv-window')) enhanceInventoryWindow();
            enhanceCaptureLog();
            enhanceNativeGlobalMarketQuality();
            injectQuestHuntButtons();

            const mapWindow = document.querySelector('.map-window');
            if (mapWindow) {
                if (renderTimeout) clearTimeout(renderTimeout);
                renderTimeout = setTimeout(buildSimpleList, 200);
            }
        }, 150);
    });

    function initializeDOMEnhancements() {
    applyMapScriptState();
    observer.observe(document.body, { childList: true, subtree: true });
    injectQuickTPButton();
    setInterval(syncSidebarLocation, 1000);
loadNativeLocks();
}
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeDOMEnhancements, { once: true });
    } else {
        initializeDOMEnhancements();
    }

})();
