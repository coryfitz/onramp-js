const COLLECTION_SERVICE = 'onramp.notification.contacts';

function normalizeApiBaseUrl(apiBaseUrl) {
  if (typeof apiBaseUrl !== 'string' || !apiBaseUrl.trim()) {
    throw new Error('A backend URL is required for remembered notification email.');
  }
  let url;
  try {
    const input = apiBaseUrl.trim().replace(/^https?:/i, scheme => scheme.toLowerCase());
    // React Native's URL implementation accepts some malformed URLs that the
    // browser parser rejects, so validate the common authority shape ourselves.
    if (!/^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?(?:\/[^\s\\?#]*)?$/i.test(input)) {
      throw new Error('Invalid backend URL');
    }
    url = new URL(input);
  } catch {
    throw new Error('Remembered notification email requires a valid backend URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash) {
    throw new Error('The backend URL must use HTTP or HTTPS without credentials, a query, or a fragment.');
  }
  if (url.port && Number(url.port) > 65535) {
    throw new Error('The backend URL has an invalid port.');
  }
  // Native URL getters preserve hostname case and explicit default ports.
  // Normalize both explicitly so native and browser scopes agree.
  let origin = url.origin.toLowerCase();
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  origin = origin.replace(/:(\d+)$/, (_match, port) =>
    Number(port) === defaultPort ? '' : `:${Number(port)}`);
  return `${origin}${url.pathname.replace(/\/+$/, '')}`;
}

function validateContact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A remembered notification contact is required.');
  }
  const email = typeof value.email === 'string' ? value.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error('A valid notification email is required.');
  }
  if (typeof value.token !== 'string' || value.token.length > 8192 ||
      !/^[\x21-\x7e]+$/.test(value.token)) {
    throw new Error('A valid notification token is required.');
  }
  const expiresAt = value.expiresAt;
  if (expiresAt !== null && (typeof expiresAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(expiresAt) ||
      !Number.isFinite(Date.parse(expiresAt)))) {
    throw new Error('The notification token must have an expiration time or explicit null.');
  }
  return {
    email,
    token: value.token,
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  };
}

/**
 * One secure collection makes clearing every backend scope independent of an
 * index. Serialize read/modify/write operations so concurrent scopes survive.
 * The adapter must be secure native storage or volatile memory, never web disk.
 */
function createNotificationContactStorage({storage}) {
  let pending = Promise.resolve();

  function serialize(operation) {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persist(contacts) {
    if (!Object.keys(contacts).length) {
      await storage.removeSecureValue(COLLECTION_SERVICE);
      return;
    }
    await storage.setSecureValue(
      COLLECTION_SERVICE,
      JSON.stringify({version: 1, contacts}),
      'notification-contacts',
    );
  }

  async function read() {
    const raw = await storage.getSecureValue(COLLECTION_SERVICE);
    const contacts = Object.create(null);
    if (raw === null) return {contacts, changed: false};
    let collection;
    try {
      collection = JSON.parse(raw);
    } catch {
      return {contacts, changed: true};
    }
    if (!collection || collection.version !== 1 || !collection.contacts ||
        typeof collection.contacts !== 'object' || Array.isArray(collection.contacts)) {
      return {contacts, changed: true};
    }
    let changed = false;
    for (const [scope, value] of Object.entries(collection.contacts)) {
      try {
        if (normalizeApiBaseUrl(scope) !== scope) throw new Error('Invalid scope');
        contacts[scope] = validateContact(value);
      } catch {
        changed = true;
      }
    }
    return {contacts, changed};
  }

  async function getNotificationContact(apiBaseUrl) {
    const scope = normalizeApiBaseUrl(apiBaseUrl);
    return serialize(async () => {
      const {contacts, changed} = await read();
      if (changed) await persist(contacts);
      return contacts[scope] || null;
    });
  }

  async function saveNotificationContact(apiBaseUrl, value) {
    const scope = normalizeApiBaseUrl(apiBaseUrl);
    const contact = validateContact(value);
    return serialize(async () => {
      const {contacts} = await read();
      // The backend decides validity, including revocation and any custom
      // expiry policy. Device time and legacy expiry metadata are not proof.
      contacts[scope] = contact;
      await persist(contacts);
    });
  }

  async function clearNotificationContact(apiBaseUrl) {
    const scope = normalizeApiBaseUrl(apiBaseUrl);
    return serialize(async () => {
      const {contacts} = await read();
      delete contacts[scope];
      await persist(contacts);
    });
  }

  async function clearAllNotificationContacts() {
    return serialize(async () => {
      await storage.removeSecureValue(COLLECTION_SERVICE);
    });
  }

  return {
    getNotificationContact,
    saveNotificationContact,
    clearNotificationContact,
    clearAllNotificationContacts,
  };
}

module.exports = {createNotificationContactStorage};
