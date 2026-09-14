import {
    chat_metadata,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    getThumbnailUrl,
    main_api,
    saveMetadata,
    saveSettingsDebounced,
} from '../../../../script.js';
import { isImageInliningSupported, oai_settings } from '../../../openai.js';
import { extension_settings } from '../../../extensions.js';
import { user_avatar, getCurrentConnectionObj, getUserAvatar } from '../../../personas.js';
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
    /** Whether gallery images are sent to the model: 'off', 'active' or 'all'. */
    injectMode: 'off',
    /** How many images to send when the whole gallery is sent. */
    injectMax: 4,
    /** Longest edge, in pixels, of an image before it is sent. */
    injectMaxEdge: 1024,
};

/** Sanitized folder names, keyed by avatar id, so we don't re-ask the server on every render. */
const folderNameCache = new Map();

/**
 * Folder listings by avatar id, so sending images does not cost a request per generation.
 * Anything that changes a folder from inside the extension forgets its entry; opening the
 * gallery reads fresh so files dropped into the folder by hand are picked up.
 * @type {Map<string, { files: string[], folder: string }>}
 */
const galleryListings = new Map();

/** The gallery popup that is currently open, so slash commands can refresh it. */
let activeGallery = null;

/** Set while an avatar is being written, so overlapping switches cannot interleave. */
let applyInFlight = false;

/** Avatars switched during this page load, each with a version stamped onto its URLs. */
const avatarVersions = new Map();

/** Downscaled data URLs, keyed by gallery path. Gallery files never change in place. */
const encodedImages = new Map();

/** Whether the missing-vision-support warning has already been logged this session. */
let warnedAboutVision = false;

/**
 * Type of the generation SillyTavern is currently building, or null between them.
 * Quiet generations are background calls made by other extensions: summarisers,
 * expression classifiers, captioners. They should not be paying for reference images.
 */
let currentGenerationType = null;

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
 * @param {object} [options]
 * @param {boolean} [options.fresh=false] Ask the server even if a listing is cached.
 * @returns {Promise<GalleryImage[]|null>} The images, or null if the folder could not be read.
 */
async function listGallery(avatarId, { fresh = false } = {}) {
    if (!avatarId) {
        return null;
    }

    const meta = getMeta(avatarId);
    let listing = fresh ? null : galleryListings.get(avatarId);

    if (!listing) {
        const response = await fetch('/api/images/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                folder: rawFolderName(avatarId),
                sortField: 'date',
                sortOrder: getSettings().sortOrder,
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

        listing = {
            files: files.filter(file => ALLOWED_EXTENSIONS.includes(String(file).split('.').pop().toLowerCase())),
            folder,
        };

        galleryListings.set(avatarId, listing);
    }

    // Labels are read live so a rename shows without another request.
    return listing.files.map(file => ({
        file: file,
        url: `user/images/${listing.folder}/${file}`,
        label: meta.labels[file] || '',
    }));
}

/**
 * Saves image files into a persona's gallery folder.
 * @param {string} avatarId
 * @param {File[]} files
 * @returns {Promise<string[]>} File names of the images that were saved, in order.
 */
async function addImages(avatarId, files) {
    const folder = rawFolderName(avatarId);
    const saved = [];

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
            const savedName = String(path).split('/').pop();

            if (original) {
                getMeta(avatarId).labels[savedName] = original;
            }

            saved.push(savedName);
        } catch (error) {
            console.error('[Persona Gallery] Failed to save image', file.name, error);
            toastr.error(t`Failed to save ${file.name}.`);
        }
    }

    if (saved.length) {
        galleryListings.delete(avatarId);
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
        galleryListings.delete(avatarId);
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

    galleryListings.delete(avatarId);

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
    // Revalidate the cache entries so a later page load gets the new file.
    await Promise.allSettled([
        fetch(getUserAvatar(avatarId), { cache: 'reload' }),
        fetch(getThumbnailUrl('persona', avatarId), { cache: 'reload' }),
    ]);

    // Browsers keep the decoded image for a URL for as long as the page is open, so an
    // unchanged URL keeps showing the old picture. Give this avatar a new version and
    // stamp it onto everything already on screen; the observer handles later renders.
    avatarVersions.set(avatarId, Date.now());
    freshenTree(document.body);
}

/**
 * Works out whether a URL points at a persona avatar or its thumbnail.
 * @param {string} raw URL as written in an attribute or a CSS url()
 * @returns {{ avatarId: string, url: URL }|null}
 */
function parsePersonaAvatarUrl(raw) {
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) {
        return null;
    }

    let url;

    try {
        url = new URL(raw, window.location.href);
    } catch {
        return null;
    }

    if (url.origin !== window.location.origin) {
        return null;
    }

    if (url.pathname.endsWith('/thumbnail') && url.searchParams.get('type') === 'persona') {
        const avatarId = url.searchParams.get('file');
        return avatarId ? { avatarId, url } : null;
    }

    // A malformed percent sequence in any same-origin image path, which a broken image
    // link in a chat message can produce, would throw here and abort the observer batch.
    let path;

    try {
        path = decodeURIComponent(url.pathname);
    } catch {
        return null;
    }

    const marker = '/User Avatars/';
    const index = path.indexOf(marker);

    return index === -1 ? null : { avatarId: path.slice(index + marker.length), url };
}

/**
 * Returns the URL carrying the avatar's current version, or null if it needs no change.
 * @param {string} raw
 */
function versionedAvatarUrl(raw) {
    const parsed = parsePersonaAvatarUrl(raw);

    if (!parsed || !avatarVersions.has(parsed.avatarId)) {
        return null;
    }

    const version = String(avatarVersions.get(parsed.avatarId));

    if (parsed.url.searchParams.get('pg') === version) {
        return null;
    }

    // The version goes first, not last. SillyTavern's avatar zoom reads the persona file
    // name as whatever follows the final '=' in the thumbnail URL, so anything appended
    // after 'file' makes it fail to recognise the persona and show the thumbnail instead
    // of the full-size image. The other parameters keep their original encoding.
    const rest = parsed.url.search.replace(/^\?/, '').split('&').filter(part => part && !part.startsWith('pg='));
    parsed.url.search = [`pg=${version}`, ...rest].join('&');

    // Keep the URL relative to the site, the way SillyTavern and themes write it.
    return `${parsed.url.pathname}${parsed.url.search}${parsed.url.hash}`;
}

/**
 * Updates one element: an image source, and any avatar URLs held in inline styles.
 * Themes such as Moonlit Echoes paint avatars as CSS backgrounds from custom
 * properties, which an image-only refresh never reaches.
 * @param {Element} element
 */
function freshenElement(element) {
    if (element instanceof HTMLImageElement) {
        const next = versionedAvatarUrl(element.getAttribute('src') || '');

        if (next) {
            element.setAttribute('src', next);
        }
    }

    if (!(element instanceof HTMLElement) || !element.getAttribute('style')?.includes('url(')) {
        return;
    }

    const style = element.style;

    for (let index = 0; index < style.length; index++) {
        const property = style[index];
        const value = style.getPropertyValue(property);

        if (!value.includes('url(')) {
            continue;
        }

        const updated = value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (match, quote, inner) => {
            const next = versionedAvatarUrl(inner);
            return next ? `url(${quote}${next}${quote})` : match;
        });

        if (updated !== value) {
            style.setProperty(property, updated, style.getPropertyPriority(property));
        }
    }
}

/**
 * Updates an element and everything inside it.
 * @param {Element} root
 */
function freshenTree(root) {
    if (!avatarVersions.size || !root) {
        return;
    }

    freshenElement(root);
    root.querySelectorAll('img, [style*="url("]').forEach(freshenElement);
}

/**
 * Catches avatars rendered or rewritten after a switch: new messages, re-rendered
 * chats, the persona list, and themes that normalise avatar URLs back to plain form.
 */
function watchAvatarRenders() {
    // Persona avatars appear outside the chat too: the persona panel, the zoomed avatar
    // popup, Quick Persona's button in the send form. So the whole document is watched,
    // and instead the busiest subtrees are skipped: message bodies, which stream text
    // several times a second and never hold a persona avatar.
    const insideMessageBody = node => node instanceof Element && !!node.closest('.mes_text, .mes_reasoning');

    const observer = new MutationObserver(mutations => {
        if (!avatarVersions.size) {
            return;
        }

        for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
                if (!insideMessageBody(mutation.target)) {
                    freshenElement(/** @type {Element} */ (mutation.target));
                }

                continue;
            }

            mutation.addedNodes.forEach(node => {
                if (node instanceof Element && !insideMessageBody(node)) {
                    freshenTree(node);
                }
            });
        }
    });

    observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src', 'style'],
    });
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
 * The chat's pins, one per persona, migrating the single-pin shape older versions wrote.
 * @returns {Record<string, string>}
 */
function getChatLocks() {
    const raw = chat_metadata?.[CHAT_LOCK_KEY];

    if (!raw || typeof raw !== 'object') {
        return {};
    }

    if (typeof raw.avatar === 'string' && typeof raw.file === 'string') {
        const migrated = { [raw.avatar]: raw.file };
        chat_metadata[CHAT_LOCK_KEY] = migrated;
        return migrated;
    }

    return raw;
}

/**
 * The image a chat has pinned for the given persona.
 * @param {string} avatarId
 * @returns {string|null}
 */
function getChatLock(avatarId) {
    const file = getChatLocks()[avatarId];
    return typeof file === 'string' && file ? file : null;
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

    const locks = getChatLocks();

    if (wasLocked) {
        delete locks[avatarId];
    } else {
        locks[avatarId] = active;
    }

    if (Object.keys(locks).length) {
        chat_metadata[CHAT_LOCK_KEY] = locks;
    } else {
        delete chat_metadata[CHAT_LOCK_KEY];
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

        if ('oncancel' in input) {
            // Modern browsers say so when the dialog is dismissed.
            input.addEventListener('cancel', () => finish([]), { once: true });
        } else {
            // Older ones do not, so give up a while after focus returns. The change event
            // normally lands first; the delay is generous so a slow selection is not lost.
            window.addEventListener('focus', () => setTimeout(() => finish([]), 2500), { once: true });
        }

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

    if (saved.length === 1) {
        toastr.success(t`Added 1 image.`);
    } else if (saved.length > 1) {
        toastr.success(t`Added ${saved.length} images.`);
    }

    return saved.length;
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
        // 'interactable' hands the tile to SillyTavern's keyboard layer: focusable, Enter and Space click.
        tile.classList.add('pg-item', 'interactable');
        tile.dataset.file = image.file;
        tile.title = t`Click to use this image for the persona`;
        tile.setAttribute('role', 'button');
        tile.setAttribute('aria-label', t`Use ${image.label || image.file} for this persona`);

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
        rename.className = 'fa-solid fa-tag pg-action pg-rename interactable';
        rename.title = t`Set a label`;
        rename.setAttribute('role', 'button');
        rename.setAttribute('aria-label', t`Set a label for ${image.label || image.file}`);
        actions.appendChild(rename);

        const remove = document.createElement('i');
        remove.className = 'fa-solid fa-trash-can pg-action pg-delete interactable';
        remove.title = t`Delete this image`;
        remove.setAttribute('role', 'button');
        remove.setAttribute('aria-label', t`Delete ${image.label || image.file}`);
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
        button.setAttribute('role', 'button');
        button.setAttribute('aria-pressed', String(locked));
        button.setAttribute('aria-disabled', String(!usable));

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
    const existing = await listGallery(avatarId, { fresh: true });

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
/*                             Sending to the model                           */
/* -------------------------------------------------------------------------- */

/**
 * Reads a gallery image and returns it as a data URL, shrunk to a sane size.
 * Reference images ride along with every request, so a full resolution portrait
 * would be paid for on every turn.
 * @param {string} url Gallery path, relative to the user data root.
 * @returns {Promise<string|null>}
 */
async function encodeForPrompt(url) {
    if (encodedImages.has(url)) {
        return encodedImages.get(url);
    }

    try {
        const response = await fetch(url, { cache: 'force-cache' });

        if (!response.ok) {
            throw new Error(`Could not read ${url}`);
        }

        const bitmap = await createImageBitmap(await response.blob());
        const maxEdge = Math.max(64, Number(getSettings().injectMaxEdge) || 1024);
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

        // Keep the cache from growing without bound across many personas.
        if (encodedImages.size > 32) {
            encodedImages.delete(encodedImages.keys().next().value);
        }

        encodedImages.set(url, dataUrl);
        return dataUrl;
    } catch (error) {
        console.error('[Persona Gallery] Could not encode an image for the prompt', error);
        return null;
    }
}

/**
 * Which images this turn should carry.
 * @param {string} avatarId
 * @returns {Promise<GalleryImage[]>}
 */
async function getImagesToSend(avatarId) {
    const settings = getSettings();
    const images = await listGallery(avatarId);

    if (!images?.length) {
        return [];
    }

    if (settings.injectMode === 'all') {
        return images.slice(0, Math.max(1, Number(settings.injectMax) || 1));
    }

    const meta = getMeta(avatarId);
    return [images.find(image => image.file === meta.active) ?? images[0]];
}

/**
 * Attaches the persona's images to the outgoing prompt so a vision model can see them.
 * SillyTavern hands us the finished message array and sends whatever we leave behind.
 * @param {{ chat: object[], dryRun: boolean }} eventData
 */
async function onPromptReady(eventData) {
    const settings = getSettings();

    if (settings.injectMode === 'off' || !Array.isArray(eventData?.chat)) {
        return;
    }

    // Only Chat Completion carries image parts; text completion has nowhere to put them.
    if (main_api !== 'openai') {
        return;
    }

    if (currentGenerationType === 'quiet') {
        console.debug('[Persona Gallery] Skipping reference images for a background prompt.');
        return;
    }

    if (!isImageInliningSupported() && !warnedAboutVision) {
        warnedAboutVision = true;
        console.warn('[Persona Gallery] Sending persona images, but SillyTavern does not list this model as vision capable. Turn image sending off if the API rejects the request.');
    }

    const avatarId = user_avatar;

    if (!avatarId) {
        return;
    }

    const images = await getImagesToSend(avatarId);

    if (!images.length) {
        return;
    }

    // The last user turn is the one position every vision API accepts images in.
    const target = [...eventData.chat].reverse().find(message => message.role === 'user')
        ?? eventData.chat[eventData.chat.length - 1];

    if (!target) {
        return;
    }

    if (typeof target.content === 'string') {
        target.content = target.content ? [{ type: 'text', text: target.content }] : [];
    }

    if (!Array.isArray(target.content)) {
        return;
    }

    const quality = oai_settings?.inline_image_quality || 'auto';
    const name = personaName(avatarId);
    let sent = 0;

    for (const image of images) {
        const dataUrl = await encodeForPrompt(image.url);

        if (!dataUrl) {
            continue;
        }

        const caption = image.label ? `${name}, ${image.label}` : name;
        target.content.push({ type: 'text', text: `[Reference image of ${caption}]` });
        target.content.push({ type: 'image_url', image_url: { url: dataUrl, detail: quality } });
        sent++;
    }

    if (sent) {
        console.debug(`[Persona Gallery] Sent ${sent} reference image(s) for ${name}.`);
    }
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
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', t`Persona Gallery`);

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
                <label for="pg_inject_mode">Send images to the model</label>
                <select id="pg_inject_mode" class="text_pole">
                    <option value="off">Do not send</option>
                    <option value="active">The image currently applied</option>
                    <option value="all">The whole gallery</option>
                </select>
                <label for="pg_inject_max">Most images to send at once</label>
                <input id="pg_inject_max" class="text_pole" type="number" min="1" max="20" step="1">
                <label for="pg_inject_edge">Longest edge of a sent image, in pixels</label>
                <input id="pg_inject_edge" class="text_pole" type="number" min="256" max="4096" step="64">
                <div class="opacity50p marginTop10">
                    Sending needs a Chat Completion API and a model that accepts images. Each
                    one is shrunk and attached to your latest message, labelled with its gallery
                    name, on every request.
                </div>
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
    const injectMode = /** @type {HTMLSelectElement} */ (document.getElementById('pg_inject_mode'));
    const injectMax = /** @type {HTMLInputElement} */ (document.getElementById('pg_inject_max'));
    const injectEdge = /** @type {HTMLInputElement} */ (document.getElementById('pg_inject_edge'));

    autoImport.checked = settings.autoImportCurrent;
    confirmDelete.checked = settings.confirmDelete;
    sortOrder.value = settings.sortOrder;
    injectMode.value = settings.injectMode;
    injectMax.value = String(settings.injectMax);
    injectEdge.value = String(settings.injectMaxEdge);

    const showControl = (control, visible) => {
        control.classList.toggle('displayNone', !visible);
        control.parentElement.querySelector(`label[for="${control.id}"]`)?.classList.toggle('displayNone', !visible);
    };

    const syncInjectVisibility = () => {
        showControl(injectMax, injectMode.value === 'all');
        showControl(injectEdge, injectMode.value !== 'off');
    };

    syncInjectVisibility();

    injectMode.addEventListener('change', () => {
        getSettings().injectMode = injectMode.value;
        syncInjectVisibility();
        saveSettingsDebounced();
    });

    injectMax.addEventListener('input', () => {
        const value = Number(injectMax.value);
        getSettings().injectMax = Number.isFinite(value) ? Math.min(20, Math.max(1, value)) : 4;
        saveSettingsDebounced();
    });

    injectEdge.addEventListener('input', () => {
        const value = Number(injectEdge.value);
        getSettings().injectMaxEdge = Number.isFinite(value) ? Math.min(4096, Math.max(256, value)) : 1024;
        // Cached encodings were made at the old size.
        encodedImages.clear();
        saveSettingsDebounced();
    });

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
        galleryListings.clear();
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

        const [savedName] = await addImages(avatarId, [file]);

        if (savedName) {
            // That file is the avatar now, so the gallery, cycling, pins and the send-to-model
            // option must all treat it as the applied one rather than the previous choice.
            // If the crop dialog is cancelled the avatar keeps its old picture and this record
            // is one step ahead; the next switch or chat load puts it right.
            getMeta(avatarId).active = savedName;
            saveSettingsDebounced();
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
    watchAvatarRenders();

    eventSource.on(event_types.PERSONA_DELETED, onPersonaDeleted);

    // The persona panel is rebuilt in some flows, so make sure the button survives.
    eventSource.on(event_types.PERSONA_CHANGED, () => addToolbarButton());
    eventSource.on(event_types.APP_READY, () => addToolbarButton());

    // Opening a chat, or changing persona inside one, can pin a different image.
    eventSource.on(event_types.CHAT_CHANGED, () => applyLockedImage());
    eventSource.on(event_types.PERSONA_CHANGED, () => applyLockedImage());

    // GENERATION_STARTED fires earlier in the same Generate call with the type, which
    // the prompt-ready event does not carry. Dry runs never reach GENERATION_ENDED, so
    // the type is cleared again at the start of the next call rather than only at the end.
    eventSource.on(event_types.GENERATION_STARTED, type => { currentGenerationType = type; });
    eventSource.on(event_types.GENERATION_ENDED, () => { currentGenerationType = null; });
    eventSource.on(event_types.GENERATION_STOPPED, () => { currentGenerationType = null; });

    // Add the images before anything else looks at the prompt. Without makeFirst, a
    // lower loading_order extension such as Prompt Inspector reads and displays the
    // prompt before we have touched it, and the images look like they never went out.
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.makeFirst(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);

    console.log('[Persona Gallery] Ready.');
});
