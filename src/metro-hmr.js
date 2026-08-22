const path = require('path');

const PATCHED = Symbol.for('onramp.metroHmr.emptyUpdateFilter');

function isEmptyHmrUpdate(message) {
  if (message?.type !== 'update') {
    return false;
  }

  const { added, modified, deleted } = message.body || {};
  return Array.isArray(added)
    && added.length === 0
    && Array.isArray(modified)
    && modified.length === 0
    && Array.isArray(deleted)
    && deleted.length === 0;
}

function sendToClients(group, message) {
  const serialized = JSON.stringify(message);
  for (const client of group.clients) {
    client.sendFn(serialized);
  }
}

function patchHmrServerClass(HmrServer) {
  const prototype = HmrServer?.prototype;
  if (
    !prototype
    || typeof prototype._handleFileChange !== 'function'
    || typeof prototype._prepareMessage !== 'function'
  ) {
    return false;
  }
  if (prototype[PATCHED]) {
    return true;
  }

  const originalHandleFileChange = prototype._handleFileChange;
  prototype._handleFileChange = async function handleOnRampFileChange(
    group,
    options,
    changeEvent
  ) {
    if (options?.isInitialUpdate) {
      return originalHandleFileChange.call(this, group, options, changeEvent);
    }

    const logger = changeEvent?.logger;
    if (logger) {
      logger.point('fileChange_end');
      logger.point('hmrPrepareAndSendMessage_start');
    }

    let completed = false;
    try {
      const message = await this._prepareMessage(group, options, changeEvent);
      if (!isEmptyHmrUpdate(message)) {
        sendToClients(group, {
          type: 'update-start',
          body: options,
        });
        sendToClients(group, message);
        sendToClients(group, {
          type: 'update-done',
          body: {
            changeId: changeEvent?.changeId,
          },
        });
      }
      completed = true;
    } finally {
      if (logger) {
        logger.point('hmrPrepareAndSendMessage_end');
        logger.end(completed ? 'SUCCESS' : 'ERROR');
      }
    }
  };

  Object.defineProperty(prototype, PATCHED, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return true;
}

function suppressEmptyMetroHmrUpdates(options = {}) {
  const resolvePackage = options.resolvePackage || require.resolve;
  const loadModule = options.loadModule || require;
  const warn = options.warn || console.warn;

  try {
    const metroPackage = resolvePackage('metro/package.json');
    const hmrServerPath = path.join(path.dirname(metroPackage), 'src', 'HmrServer.js');
    const moduleValue = loadModule(hmrServerPath);
    const HmrServer = moduleValue.default || moduleValue;
    if (patchHmrServerClass(HmrServer)) {
      return true;
    }
  } catch (error) {
    warn(
      'Warning: OnRamp could not install its Metro empty-update filter. '
      + `Fast Refresh will continue without it: ${error.message}`
    );
    return false;
  }

  warn(
    'Warning: This Metro version does not expose the HMR hooks expected by '
    + 'OnRamp. Fast Refresh will continue without the empty-update filter.'
  );
  return false;
}

module.exports = {
  isEmptyHmrUpdate,
  patchHmrServerClass,
  suppressEmptyMetroHmrUpdates,
};
