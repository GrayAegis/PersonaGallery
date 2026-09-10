import {
    chat_metadata,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    getThumbnailUrl,
    saveMetadata,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { user_avatar, getCurrentConnectionObj, getUserAvatar, getUserAvatars } from '../../../personas.js';
import { power_user } from '../../../power-user.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { getBase64Async, getFileExtension, getSanitizedFilename, saveBase64AsFile } from '../../../utils.js';
import { DragAndDropHandler } from '../../../dragdrop.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from '../../../slash-commands/SlashCommandEnumValue.js';
import { t } from '../../../i18n.js';

const MODULE_NAME = 'personaGallery';
const FOLDER_PREFIX = 'persona-gallery';
const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'jfif'];

/** Where a chat's pinned image is recorded, alongside SillyTavern's own chat metadata. */
const CHAT_LOCK_KEY = 'personaGalleryImage';

const defaultSettings = {
    /** Copy the persona's existing avatar into the gallery the first time it is opened. */
    autoImportCurrent: true,
    /** Ask before deleting an image from a gallery. */
    confirmDelete: true,
    /** Sort order for the folder listing. */
    sortOrder: 'asc',
};

/** Sanitized folder names, keyed by avatar id, so we don't re-ask the server on every render. */
const folderNameCache = new Map();

/** The gallery popup that is currently open, so slash commands can refresh it. */
let activeGallery = null;

/** Set while an avatar is being written, so overlapping switches cannot interleave. */
let applyInFlight = false;

/**
 * @typedef {object} GalleryImage
 * @property {string} file File name inside the gallery folder.
 * @property {string} url Path relative to the user data root.
 * @property {string} label Human-readable label, or an empty string.
 */

/* -------------------------------------------------------------------------- */
/*                                  Settings                                  */
/* -------------------------------------------------------------------------- */

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[MODULE_NAME];

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }

    if (!settings.meta || typeof settings.meta !== 'object') {
        settings.meta = {};
    }

    return settings;
}

/**
 * Per-persona metadata: which image is active and what each one is called.
 * @param {string} avatarId
 */
function getMeta(avatarId) {
    const settings = getSettings();

    if (!settings.meta[avatarId]) {
        settings.meta[avatarId] = { active: null, labels: {}, locks: {}, fallback: null, imported: false };
    }

    const meta = settings.meta[avatarId];

    if (!meta.labels || typeof meta.labels !== 'object') {
        meta.labels = {};
    }

    if (!meta.locks || typeof meta.locks !== 'object') {
        meta.locks = {};
    }

    return meta;
}

/* -------------------------------------------------------------------------- */
/*                             Server operations                              */
/* -------------------------------------------------------------------------- */

/**
 * Name of the image folder that holds this persona's gallery.
 * @param {string} avatarId
 */
function rawFolderName(avatarId) {
    return `${FOLDER_PREFIX}-${avatarId}`;
}

/**
 * The folder name as the server stores it, needed to build image URLs.
 * @param {string} avatarId
 * @returns {Promise<string>}
 */
async function resolveFolderName(avatarId) {
    const raw = rawFolderName(avatarId);

    if (folderNameCache.has(raw)) {
        return folderNameCache.get(raw);
    }

    const sanitized = await getSanitizedFilename(raw);
    folderNameCache.set(raw, sanitized);
    return sanitized;
}

/**
 * Reads the gallery folder for a persona.
 * @param {string} avatarId
 * @returns {Promise<GalleryImage[]|null>} The images, or null if the folder could not be read.
 */
async function listGallery(avatarId) {
    if (!avatarId) {
        return null;
    }

    const settings = getSettings();
    const meta = getMeta(avatarId);

    const response = await fetch('/api/images/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            folder: rawFolderName(avatarId),
            sortField: 'date',
            sortOrder: settings.sortOrder,
        }),
    });

    if (!response.ok) {
        console.error('[Persona Gallery] Failed to list gallery images', response.status);
        return null;
    }

    const files = await response.json();
    const folder = await resolveFolderName(avatarId);

    // Files can be removed from the folder by hand, so drop labels that no longer point anywhere.
    const orphans = Object.keys(meta.labels).filter(file => !files.includes(file));

    if (orphans.length) {
        orphans.forEach(file => delete meta.labels[file]);
        saveSettingsDebounced();
    }

    return files
        .filter(file => ALLOWED_EXTENSIONS.includes(String(file).split('.').pop().toLowerCase()))
        .map(file => ({
            file: file,
            url: `user/images/${folder}/${file}`,
            label: meta.labels[file] || '',
        }));
}

/**
 * Saves image files into a persona's gallery folder.
 * @param {string} avatarId
 * @param {File[]} files
 * @returns {Promise<number>} How many files were saved.
 */
async function addImages(avatarId, files) {
    const folder = rawFolderName(avatarId);
    let saved = 0;

    for (const file of files) {
        const extension = getFileExtension(file) || 'png';

        if (!ALLOWED_EXTENSIONS.includes(extension)) {
            toastr.warning(t`Skipped ${file.name}: unsupported image type.`);
            continue;
        }

        try {
            const dataUrl = await getBase64Async(file);
            const base64 = dataUrl.split(',')[1];

            // Keep the original name as the label, but make the stored file name collision-proof.
            const original = String(file.name).replace(/\.[^.]+$/, '').trim();
            const stem = original.replace(/[^\w\- ]+/g, '').slice(0, 40) || 'image';
            const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            const path = await saveBase64AsFile(base64, folder, `${stem}-${unique}`, extension);

            if (original) {
                getMeta(avatarId).labels[String(path).split('/').pop()] = original;
            }

            saved++;
        } catch (error) {
            console.error('[Persona Gallery] Failed to save image', file.name, error);
            toastr.error(t`Failed to save ${file.name}.`);
        }
    }

    if (saved) {
        saveSettingsDebounced();
    }

    return saved;
}

/**
 * Copies the persona's current avatar into its gallery, so switching away from it is reversible.
 * @param {string} avatarId
 */
async function importCurrentAvatar(avatarId) {
    try {
        const response = await fetch(getUserAvatar(avatarId));

        if (!response.ok) {
            return false;
        }

        const blob = await response.blob();
        const dataUrl = await getBase64Async(blob);
        const base64 = dataUrl.split(',')[1];
        const path = await saveBase64AsFile(base64, rawFolderName(avatarId), 'original', 'png');

        const meta = getMeta(avatarId);
        const file = String(path).split('/').pop();
        meta.active = file;
        meta.labels[file] = t`Original`;
        meta.imported = true;
        saveSettingsDebounced();
        return true;
    } catch (error) {
        console.error('[Persona Gallery] Failed to import the current avatar', error);
        return false;
    }
}

/**
 * Removes an image from a persona's gallery folder.
 * @param {string} avatarId
 * @param {GalleryImage} image
 */
async function deleteImage(avatarId, image) {
    const response = await fetch('/api/images/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ path: image.url }),
    });

    if (!response.ok) {
        toastr.error(t`Failed to delete the image.`);
        return false;
    }

    const meta = getMeta(avatarId);
    delete meta.labels[image.file];

    if (meta.active === image.file) {
        meta.active = null;
    }

    // Leave no pin pointing at a file that is gone.
    if (meta.fallback === image.file) {
        meta.fallback = null;
    }

    Object.keys(meta.locks)
        .filter(key => meta.locks[key] === image.file)
        .forEach(key => delete meta.locks[key]);

    saveSettingsDebounced();
    return true;
}

/**
 * Writes a gallery image over the persona's avatar file, leaving the persona record untouched.
 * @param {string} avatarId
 * @param {GalleryImage} image
 */
async function applyImage(avatarId, image) {
    if (applyInFlight) {
        console.debug('[Persona Gallery] Ignoring a switch while another one is still running.');
        return false;
    }

    applyInFlight = true;

    try {
        const source = await fetch(image.url, { cache: 'no-cache' });

        if (!source.ok) {
            throw new Error(`Could not read ${image.url}`);
        }

        const blob = await source.blob();
        const file = new File([blob], 'avatar.png', { type: blob.type || 'image/png' });

        const formData = new FormData();
        formData.append('avatar', file);
        formData.append('overwrite_name', avatarId);

        const response = await fetch('/api/avatars/upload', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            cache: 'no-cache',
            body: formData,
        });

        if (!response.ok) {
            throw new Error(`Upload failed: ${response.statusText}`);
        }

        const meta = getMeta(avatarId);
        meta.active = image.file;
        saveSettingsDebounced();

        await refreshAvatarDisplays(avatarId);

        if (activeGallery?.avatarId === avatarId) {
            await renderGallery(activeGallery.container, avatarId);
        }

        return true;
    } catch (error) {
        console.error('[Persona Gallery] Failed to apply the image', error);
        toastr.error(t`Failed to set the persona image.`);
        return false;
    } finally {
        applyInFlight = false;
    }
}

/**
 * The avatar file changed on disk but its URL did not, so every cached copy has to be replaced.
 * @param {string} avatarId
 */
async function refreshAvatarDisplays(avatarId) {
    const avatarUrl = getUserAvatar(avatarId);
    const thumbUrl = getThumbnailUrl('persona', avatarId);

    // Revalidate the cache entries so later renders of the plain URLs are correct.
    await Promise.allSettled([
        fetch(avatarUrl, { cache: 'reload' }),
        fetch(thumbUrl, { cache: 'reload' }),
    ]);

    // Repaint the elements that are on screen right now.
    const stamp = Date.now();

    document.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || '';

        if (src.startsWith('user/images/') || src.startsWith('/user/images/')) {
            return;
        }

        if (!src.includes(encodeURIComponent(avatarId)) && !src.includes(avatarId)) {
            return;
        }

        const base = src.split('#')[0].replace(/[?&]pg=\d+/, '');
        img.setAttribute('src', `${base}${base.includes('?') ? '&' : '?'}pg=${stamp}`);
    });

    await getUserAvatars(true, avatarId);
}

/* -------------------------------------------------------------------------- */
/*                                 Switching                                  */
/* -------------------------------------------------------------------------- */

/**
 * Moves to another image in the persona's gallery.
 * @param {string} avatarId
 * @param {number} delta +1 for the next image, -1 for the previous one.
 */
async function cycleImage(avatarId, delta) {
    const images = await listGallery(avatarId);

    if (!images) {
        toastr.error(t`Could not read this persona's gallery.`);
        return null;
    }

    if (images.length < 2) {
        toastr.info(t`This persona needs at least two gallery images to cycle.`);
        return null;
    }

    const meta = getMeta(avatarId);
    const current = images.findIndex(image => image.file === meta.active);
    const start = current === -1 ? 0 : current;
    const next = images[(start + delta + images.length) % images.length];
    const applied = await applyImage(avatarId, next);

    return applied ? next : null;
}

/**
 * Finds a gallery image by label, file name, or 1-based index.
 * @param {GalleryImage[]} images
 * @param {string} needle
 */
function findImage(images, needle) {
    const query = String(needle).trim();

    if (!query) {
        return null;
    }

    const index = Number(query);

    if (Number.isInteger(index) && index >= 1 && index <= images.length) {
        return images[index - 1];
    }

    const lower = query.toLowerCase();

    return images.find(image => image.label.toLowerCase() === lower)
        ?? images.find(image => image.file.toLowerCase() === lower)
        ?? images.find(image => image.label.toLowerCase().includes(lower))
        ?? images.find(image => image.file.toLowerCase().includes(lower))
        ?? null;
}

/* -------------------------------------------------------------------------- */
/*                                   Locks                                    */
/* -------------------------------------------------------------------------- */

/**
 * Key for the character or group currently in view, matching how SillyTavern
 * keys its own persona connections.
 * @returns {string|null}
 */
function currentConnectionKey() {
    const connection = getCurrentConnectionObj();
    return connection ? `${connection.type}:${connection.id}` : null;
}

/**
 * The image a chat has pinned, if it belongs to the given persona.
 * @param {string} avatarId
 * @returns {string|null}
 */
function getChatLock(avatarId) {
    const lock = chat_metadata?.[CHAT_LOCK_KEY];
    return lock?.avatar === avatarId && lock.file ? lock.file : null;
}

/**
 * The image pinned to the character or group currently in view.
 * @param {string} avatarId
 * @returns {string|null}
 */
function getCharacterLock(avatarId) {
    const key = currentConnectionKey();
    return key ? (getMeta(avatarId).locks[key] ?? null) : null;
}

/**
 * Which image should be showing right now, most specific rule first.
 * @param {string} avatarId
 * @returns {string|null}
 */
function resolveLockedFile(avatarId) {
    return getChatLock(avatarId)
        ?? getCharacterLock(avatarId)
        ?? getMeta(avatarId).fallback
        ?? null;
}

/**
 * Reads the state of all three scopes for the persona.
 * @param {string} avatarId
 */
function getLockStates(avatarId) {
    const meta = getMeta(avatarId);
    const active = meta.active;

    return {
        available: {
            default: true,
            character: !!currentConnectionKey(),
            chat: !!getCurrentChatId(),
        },
        locked: {
            default: !!active && meta.fallback === active,
            character: !!active && getCharacterLock(avatarId) === active,
            chat: !!active && getChatLock(avatarId) === active,
        },
    };
}

/**
 * Pins or unpins the persona's active image for one scope.
 * @param {string} avatarId
 * @param {'default'|'character'|'chat'} scope
 */
async function toggleLock(avatarId, scope) {
    const meta = getMeta(avatarId);
    const active = meta.active;

    if (!active) {
        toastr.info(t`Apply an image first, then pin it.`);
        return;
    }

    const states = getLockStates(avatarId);

    if (!states.available[scope]) {
        toastr.info(scope === 'character'
            ? t`Open a character or group chat first.`
            : t`Open a chat first.`);
        return;
    }

    const wasLocked = states.locked[scope];

    if (scope === 'default') {
        meta.fallback = wasLocked ? null : active;
        saveSettingsDebounced();
        return;
    }

    if (scope === 'character') {
        const key = currentConnectionKey();

        if (wasLocked) {
            delete meta.locks[key];
        } else {
            meta.locks[key] = active;
        }

        saveSettingsDebounced();
        return;
    }

    if (wasLocked) {
        delete chat_metadata[CHAT_LOCK_KEY];
    } else {
        chat_metadata[CHAT_LOCK_KEY] = { avatar: avatarId, file: active };
    }

    // Write it now rather than on a debounce: leaving the chat within the next second
    // would otherwise discard the pin the user just set.
    await saveMetadata();
}

/**
 * Applies whatever the current chat and character say this persona should be wearing.
 */
async function applyLockedImage() {
    const avatarId = user_avatar;

    if (!avatarId || applyInFlight) {
        return;
    }

    const target = resolveLockedFile(avatarId);

    if (!target || getMeta(avatarId).active === target) {
        return;
    }

    const images = await listGallery(avatarId);

    if (!images) {
        return;
    }

    const image = images.find(candidate => candidate.file === target);

    if (!image) {
        console.debug('[Persona Gallery] A pinned image no longer exists:', target);
        return;
    }

    await applyImage(avatarId, image);
}

/* -------------------------------------------------------------------------- */
/*                                     UI                                     */
/* -------------------------------------------------------------------------- */

function personaName(avatarId) {
    return power_user.personas?.[avatarId] || avatarId;
}

/**
 * Opens a file picker and returns the chosen files.
 * @returns {Promise<File[]>}
 */
function pickFiles() {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);

        let settled = false;

        const finish = files => {
            if (settled) {
                return;
            }

            settled = true;
            input.remove();
            resolve(files);
        };

        input.addEventListener('change', () => finish(Array.from(input.files || [])), { once: true });

        // Nothing fires when the dialog is dismissed, so give up shortly after focus returns.
        window.addEventListener('focus', () => setTimeout(() => finish([]), 1000), { once: true });

        input.click();
    });
}

/**
 * Adds files to a gallery and reports the result.
 * @param {string} avatarId
 * @param {File[]} files
 */
async function addAndReport(avatarId, files) {
    const saved = await addImages(avatarId, files);

    if (saved === 1) {
        toastr.success(t`Added 1 image.`);
    } else if (saved > 1) {
        toastr.success(t`Added ${saved} images.`);
    }

    return saved;
}

/**
 * Builds the gallery grid inside an already-open popup.
 * @param {HTMLElement} container
 * @param {string} avatarId
 */
async function renderGallery(container, avatarId) {
    const grid = container.querySelector('.pg-grid');
    const count = container.querySelector('.pg-count');
    const header = container.querySelector('.pg-current-avatar');
    const meta = getMeta(avatarId);

    if (header instanceof HTMLImageElement) {
        header.src = getThumbnailUrl('persona', avatarId, true);
    }

    grid.innerHTML = '';
    grid.classList.add('pg-loading');

    const images = await listGallery(avatarId);
    grid.classList.remove('pg-loading');
    renderLockRow(container, avatarId);

    if (!images) {
        count.textContent = '';
        const failed = document.createElement('div');
        failed.classList.add('pg-empty');
        failed.textContent = t`Could not read the gallery folder. Check the SillyTavern server log.`;
        grid.appendChild(failed);
        return;
    }

    count.textContent = images.length === 1 ? t`1 image` : t`${images.length} images`;

    if (!images.length) {
        const empty = document.createElement('div');
        empty.classList.add('pg-empty');
        empty.textContent = t`No images yet. Use Add images, or drop image files onto this window.`;
        grid.appendChild(empty);
        return;
    }

    for (const [index, image] of images.entries()) {
        const tile = document.createElement('div');
        tile.classList.add('pg-item');
        tile.dataset.file = image.file;
        tile.title = t`Click to use this image for the persona`;

        if (meta.active === image.file) {
            tile.classList.add('pg-active');
        }

        const img = document.createElement('img');
        img.src = image.url;
        img.loading = 'lazy';
        img.alt = image.label || image.file;
        tile.appendChild(img);

        const badge = document.createElement('div');
        badge.classList.add('pg-index');
        badge.textContent = String(index + 1);
        tile.appendChild(badge);

        const label = document.createElement('div');
        label.classList.add('pg-label');
        label.textContent = image.label || t`Untitled`;
        label.classList.toggle('pg-untitled', !image.label);
        tile.appendChild(label);

        const actions = document.createElement('div');
        actions.classList.add('pg-actions');

        const rename = document.createElement('i');
        rename.className = 'fa-solid fa-tag pg-action pg-rename';
        rename.title = t`Set a label`;
        actions.appendChild(rename);

        const remove = document.createElement('i');
        remove.className = 'fa-solid fa-trash-can pg-action pg-delete';
        remove.title = t`Delete this image`;
        actions.appendChild(remove);

        tile.appendChild(actions);
        tile.addEventListener('click', event => onTileClick(event, container, avatarId, image));
        grid.appendChild(tile);
    }
}

/**
 * Paints the three pin buttons to match the current chat and character.
 * @param {HTMLElement} container
 * @param {string} avatarId
 */
function renderLockRow(container, avatarId) {
    const states = getLockStates(avatarId);
    const hasActive = !!getMeta(avatarId).active;

    container.querySelectorAll('.pg-lock').forEach(button => {
        const scope = button.getAttribute('data-scope');
        const locked = states.locked[scope];
        const usable = states.available[scope] && hasActive;

        button.classList.toggle('pg-locked', locked);
        button.classList.toggle('pg-lock-unavailable', !usable);

        const icon = button.querySelector('i');
        icon.classList.toggle('fa-lock', locked);
        icon.classList.toggle('fa-unlock', !locked);
    });
}

/**
 * Handles a click anywhere on a gallery tile.
 * @param {MouseEvent} event
 * @param {HTMLElement} container
 * @param {string} avatarId
 * @param {GalleryImage} image
 */
async function onTileClick(event, container, avatarId, image) {
    const target = /** @type {HTMLElement} */ (event.target);

    if (target.classList.contains('pg-rename')) {
        event.stopPropagation();
        const value = await Popup.show.input(t`Label for this image`, null, image.label);

        if (value === null) {
            return;
        }

        const trimmed = String(value).trim();
        const meta = getMeta(avatarId);

        if (trimmed) {
            meta.labels[image.file] = trimmed;
        } else {
            delete meta.labels[image.file];
        }

        saveSettingsDebounced();
        await renderGallery(container, avatarId);
        return;
    }

    if (target.classList.contains('pg-delete')) {
        event.stopPropagation();

        if (getSettings().confirmDelete) {
            const confirmed = await Popup.show.confirm(
                t`Delete this image?`,
                t`It is removed from the gallery folder. The persona and its current avatar are not affected.`,
            );

            if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
                return;
            }
        }

        await deleteImage(avatarId, image);
        await renderGallery(container, avatarId);
        return;
    }

    // applyImage repaints the open gallery, including the header avatar.
    await applyImage(avatarId, image);
}

/**
 * Opens the gallery for a persona.
 * @param {string} avatarId
 */
async function openGallery(avatarId) {
    if (!avatarId) {
        toastr.warning(t`Select a persona first.`);
        return;
    }

    if (activeGallery) {
        console.debug('[Persona Gallery] A gallery is already open.');
        return;
    }

    const container = document.createElement('div');
    container.classList.add('persona-gallery-popup');
    container.innerHTML = `
        <div class="pg-header flex-container alignitemscenter">
            <img class="pg-current-avatar" src="${getThumbnailUrl('persona', avatarId, true)}" alt="">
            <div class="flex1 pg-heading">
                <h3 class="margin0"></h3>
                <small class="pg-count opacity50p"></small>
            </div>
            <div class="pg-add menu_button menu_button_icon">
                <i class="fa-solid fa-plus"></i>
                <span></span>
            </div>
        </div>
        <div class="pg-grid"></div>
        <div class="pg-locks flex-container alignitemscenter">
            <span class="pg-locks-label opacity50p"></span>
            <div class="pg-lock menu_button menu_button_icon" data-scope="default">
                <i class="fa-solid fa-unlock fa-fw"></i><span></span>
            </div>
            <div class="pg-lock menu_button menu_button_icon" data-scope="character">
                <i class="fa-solid fa-unlock fa-fw"></i><span></span>
            </div>
            <div class="pg-lock menu_button menu_button_icon" data-scope="chat">
                <i class="fa-solid fa-unlock fa-fw"></i><span></span>
            </div>
        </div>
        <div class="pg-hint opacity50p"></div>
    `;

    container.querySelector('.pg-heading h3').textContent = personaName(avatarId);
    container.querySelector('.pg-add span').textContent = t`Add images`;
    container.querySelector('.pg-locks-label').textContent = t`Pin the current image to:`;
    container.querySelector('.pg-hint').textContent =
        t`Click an image to make it this persona's avatar. Drop image files here to add them.`;

    const lockLabels = {
        default: t`Default`,
        character: t`Character`,
        chat: t`Chat`,
    };

    const lockTitles = {
        default: t`Use this image whenever no chat or character asks for another one.`,
        character: t`Use this image while this character or group is open.`,
        chat: t`Use this image while this chat is open.`,
    };

    container.querySelectorAll('.pg-lock').forEach(button => {
        const scope = button.getAttribute('data-scope');
        button.querySelector('span').textContent = lockLabels[scope];
        button.title = lockTitles[scope];
        button.addEventListener('click', async () => {
            await toggleLock(avatarId, scope);
            renderLockRow(container, avatarId);
        });
    });

    const meta = getMeta(avatarId);
    const existing = await listGallery(avatarId);

    // A failed listing must not look like an empty gallery, or the import would
    // overwrite the saved original with whatever is applied right now.
    if (existing && !existing.length && !meta.imported && getSettings().autoImportCurrent) {
        await importCurrentAvatar(avatarId);
    }

    container.querySelector('.pg-add').addEventListener('click', async () => {
        const files = await pickFiles();

        if (!files.length) {
            return;
        }

        await addAndReport(avatarId, files);
        await renderGallery(container, avatarId);
    });

    // The handler delegates from document.body, so it needs a selector string rather than the node.
    const dropHandler = new DragAndDropHandler('.persona-gallery-popup', async files => {
        const images = files.filter(file => file.type.startsWith('image/'));

        if (!images.length) {
            return;
        }

        await addAndReport(avatarId, images);
        await renderGallery(container, avatarId);
    });

    activeGallery = { container, avatarId };

    const popup = new Popup(container, POPUP_TYPE.DISPLAY, '', {
        wider: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        onClose: () => {
            dropHandler.destroy();
            activeGallery = null;
        },
    });

    await renderGallery(container, avatarId);
    await popup.show();
}

/* -------------------------------------------------------------------------- */
/*                              Slash commands                                */
/* -------------------------------------------------------------------------- */

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'persona-gallery',
        callback: async () => {
            await openGallery(user_avatar);
            return '';
        },
        helpString: 'Opens the image gallery for the current persona.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'persona-image',
        callback: async (_args, value) => {
            const avatarId = user_avatar;
            const query = String(value ?? '').trim();

            if (!query) {
                const images = await listGallery(avatarId);

                if (!images) {
                    toastr.error(t`Could not read this persona's gallery.`);
                    return '';
                }

                return images.map((image, index) => `${index + 1}. ${image.label || image.file}`).join('\n');
            }

            if (query === 'next' || query === 'prev') {
                const image = await cycleImage(avatarId, query === 'next' ? 1 : -1);
                return image ? (image.label || image.file) : '';
            }

            const images = await listGallery(avatarId);

            if (!images) {
                toastr.error(t`Could not read this persona's gallery.`);
                return '';
            }

            const image = findImage(images, query);

            if (!image) {
                toastr.warning(t`No gallery image matches ${query}.`);
                return '';
            }

            const applied = await applyImage(avatarId, image);
            return applied ? (image.label || image.file) : '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'label, file name, 1-based index, "next", or "prev". Omit to list the gallery.',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: () => {
                    const meta = getSettings().meta[user_avatar];
                    const labels = Object.values(meta?.labels ?? {});
                    return ['next', 'prev', ...labels].map(label =>
                        new SlashCommandEnumValue(String(label), null, enumTypes.name));
                },
            }),
        ],
        helpString: `
            <div>
                Switches the current persona's avatar to one of its gallery images.
            </div>
            <div>
                <strong>Examples:</strong>
                <ul>
                    <li><pre><code>/persona-image</code></pre> lists the gallery</li>
                    <li><pre><code>/persona-image next</code></pre> moves to the next image</li>
                    <li><pre><code>/persona-image Winter coat</code></pre> switches by label</li>
                    <li><pre><code>/persona-image 2</code></pre> switches by position</li>
                </ul>
            </div>
        `,
        returns: 'the label of the image that was applied',
    }));
}

/* -------------------------------------------------------------------------- */
/*                                    Init                                    */
/* -------------------------------------------------------------------------- */

function addToolbarButton() {
    if (document.getElementById('persona_gallery_button')) {
        return;
    }

    const block = document.querySelector('.persona_controls_buttons_block');

    if (!block) {
        return;
    }

    const button = document.createElement('div');
    button.id = 'persona_gallery_button';
    button.className = 'menu_button fa-solid fa-images';
    button.title = t`Persona Gallery\n\nClick to open\nShift-click for the next image`;

    button.addEventListener('click', async event => {
        if (event.shiftKey) {
            await cycleImage(user_avatar, 1);
            return;
        }

        await openGallery(user_avatar);
    });

    const anchor = document.getElementById('persona_set_image_button');

    if (anchor) {
        anchor.after(button);
    } else {
        block.appendChild(button);
    }
}

function addSettingsPanel() {
    const settings = getSettings();

    const html = `
    <div class="persona-gallery-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Persona Gallery</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="pg_auto_import">
                    <input id="pg_auto_import" type="checkbox">
                    <span>Save the existing avatar into a new gallery</span>
                </label>
                <label class="checkbox_label" for="pg_confirm_delete">
                    <input id="pg_confirm_delete" type="checkbox">
                    <span>Confirm before deleting a gallery image</span>
                </label>
                <label for="pg_sort_order">Gallery order</label>
                <select id="pg_sort_order" class="text_pole">
                    <option value="asc">Oldest first</option>
                    <option value="desc">Newest first</option>
                </select>
                <div class="opacity50p marginTop10">
                    Images are stored in the user data folder, under
                    <code>user/images/persona-gallery-&lt;persona&gt;</code>.
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    const autoImport = /** @type {HTMLInputElement} */ (document.getElementById('pg_auto_import'));
    const confirmDelete = /** @type {HTMLInputElement} */ (document.getElementById('pg_confirm_delete'));
    const sortOrder = /** @type {HTMLSelectElement} */ (document.getElementById('pg_sort_order'));

    autoImport.checked = settings.autoImportCurrent;
    confirmDelete.checked = settings.confirmDelete;
    sortOrder.value = settings.sortOrder;

    autoImport.addEventListener('change', () => {
        getSettings().autoImportCurrent = autoImport.checked;
        saveSettingsDebounced();
    });

    confirmDelete.addEventListener('change', () => {
        getSettings().confirmDelete = confirmDelete.checked;
        saveSettingsDebounced();
    });

    sortOrder.addEventListener('change', () => {
        getSettings().sortOrder = sortOrder.value;
        saveSettingsDebounced();
    });
}

/**
 * SillyTavern's own Change Persona Image button overwrites the avatar file without
 * telling anyone, which would leave that picture outside the gallery and lose it on
 * the next switch. No event is emitted for it, so read the same file it was given.
 */
function watchExternalAvatarChanges() {
    $('#avatar_upload_file').on('change', async function () {
        // Read both synchronously: SillyTavern resets the form once it is finished.
        const avatarId = String($('#avatar_upload_overwrite').val() || '');
        const file = this.files?.[0];

        if (!avatarId || !file) {
            return;
        }

        const saved = await addImages(avatarId, [file]);

        if (saved) {
            console.debug('[Persona Gallery] Captured an externally set avatar for', avatarId);
        }

        if (activeGallery?.avatarId === avatarId) {
            await renderGallery(activeGallery.container, avatarId);
        }
    });
}

/**
 * Drops metadata for personas that no longer exist.
 * @param {{ avatarId?: string }} data
 */
function onPersonaDeleted(data) {
    const avatarId = data?.avatarId;

    if (!avatarId) {
        return;
    }

    delete getSettings().meta[avatarId];
    saveSettingsDebounced();
}

jQuery(async () => {
    getSettings();
    addToolbarButton();
    addSettingsPanel();
    registerSlashCommands();

    watchExternalAvatarChanges();

    eventSource.on(event_types.PERSONA_DELETED, onPersonaDeleted);

    // The persona panel is rebuilt in some flows, so make sure the button survives.
    eventSource.on(event_types.PERSONA_CHANGED, () => addToolbarButton());
    eventSource.on(event_types.APP_READY, () => addToolbarButton());

    // Opening a chat, or changing persona inside one, can pin a different image.
    eventSource.on(event_types.CHAT_CHANGED, () => applyLockedImage());
    eventSource.on(event_types.PERSONA_CHANGED, () => applyLockedImage());

    console.log('[Persona Gallery] Ready.');
});
