import { RuleHelper } from 'textlint-rule-helper';
import fetch from 'isomorphic-fetch';
import URL from 'url';
import fs from 'fs-extra';
import minimatch from 'minimatch';
import { isAbsolute } from 'path';
import { getURLOrigin } from 'get-url-origin';

const DEFAULT_OPTIONS = {
  checkRelative: true, // {boolean} `false` disables the checks for relative URIs
  baseURI: null, // {String|null} a base URI to resolve relative URIs.
  ignore: [], // {Array<String>} URIs to be skipped from availability checks.
  preferGET: [], // {Array<String>} origins to prefer GET over HEAD.
};

// Adopted from http://stackoverflow.com/a/3809435/951517
const URI_REGEXP = /(?:https?:)?\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{2,256}\.[a-z]{2,6}\b(?:[-a-zA-Z0-9@:%_+.~#?&//=]*)/g;

/**
 * Returns `true` if a given URI is relative.
 * @param {string} uri
 * @return {boolean}
 * @see https://github.com/panosoft/is-local-path
 */
function isRelative(uri) {
  const { host } = URL.parse(uri);
  return host === null || host === '';
}

/**
 * Returns if a given URI indicates a local file.
 * @param {string} uri
 * @return {boolean}
 * @see https://nodejs.org/api/path.html#path_path_isabsolute_path
 */
function isLocal(uri) {
  if (isAbsolute(uri)) {
    return true;
  }
  return isRelative(uri);
}

/**
 * Return `true` if the `code` is redirect status code.
 * @see https://fetch.spec.whatwg.org/#redirect-status
 * @param {number} code
 * @returns {boolean}
 */
function isRedirect(code) {
  return (
    code === 301 || code === 302 || code === 303 || code === 307 || code === 308
  );
}

function isIgnored(uri, ignore = []) {
  return ignore.some((pattern) => minimatch(uri, pattern));
}

/**
 * Checks if a given URI is alive or not.
 * @param {string} uri
 * @param {string} method
 * @return {{ ok: boolean, redirect?: string, message: string }}
 */
async function isAliveURI(uri, method = 'HEAD') {
  const opts = {
    method,
    // Disable gzip compression in Node.js
    // to avoid the zlib's "unexpected end of file" error
    // https://github.com/request/request/issues/2045
    compress: false,
    // Use `manual` redirect behaviour to get HTTP redirect status code
    // and see what kind of redirect is occurring
    redirect: 'manual',
  };

  try {
    const res = await fetch(uri, opts);

    if (isRedirect(res.status)) {
      const finalRes = await fetch(
        uri,
        Object.assign({}, opts, { redirect: 'follow' }),
      );

      return {
        ok: finalRes.ok,
        redirected: true,
        redirectTo: finalRes.url,
        message: `${res.status} ${res.statusText}`,
      };
    }

    if (!res.ok && method === 'HEAD') {
      return isAliveURI(uri, 'GET');
    }

    return {
      ok: res.ok,
      message: `${res.status} ${res.statusText}`,
    };
  } catch (ex) {
    // Retry with `GET` method if the request failed
    // as some servers don't accept `HEAD` requests but are OK with `GET` requests.
    // https://github.com/textlint-rule/textlint-rule-no-dead-link/pull/86
    if (method === 'HEAD') {
      return isAliveURI(uri, 'GET');
    }

    return {
      ok: false,
      message: ex.message,
    };
  }
}

/**
 * Check if a given file exists
 */
async function isAliveLocalFile(filePath) {
  try {
    await fs.access(filePath.replace(/[?#].*?$/, ''));

    return {
      ok: true,
    };
  } catch (ex) {
    return {
      ok: false,
      message: ex.message,
    };
  }
}

function reporter(context, options = {}) {
  const { Syntax, getSource, report, RuleError, fixer, getFilePath } = context;
  const helper = new RuleHelper(context);
  const opts = Object.assign({}, DEFAULT_OPTIONS, options);

  /**
   * Checks a given URI's availability and report if it is dead.
   * @param {TextLintNode} node TextLintNode the URI belongs to.
   * @param {string} uri a URI string to be linted.
   * @param {number} index column number the URI is located at.
   */
  const lint = async ({ node, uri, index }) => {
    if (isIgnored(uri, opts.ignore)) {
      return;
    }

    if (isRelative(uri)) {
      if (!opts.checkRelative) {
        return;
      }

      const filePath = getFilePath();
      const base = opts.baseURI || filePath;
      if (!base) {
        const message =
          'Unable to resolve the relative URI. Please check if the base URI is correctly specified.';

        report(node, new RuleError(message, { index }));
        return;
      }

      // eslint-disable-next-line no-param-reassign
      uri = URL.resolve(base, uri);
    }

    const method =
      opts.preferGET.filter(
        (origin) => getURLOrigin(uri) === getURLOrigin(origin),
      ).length > 0
        ? 'GET'
        : 'HEAD';

    const result = isLocal(uri)
      ? await isAliveLocalFile(uri)
      : await isAliveURI(uri, method);
    const { ok, redirected, redirectTo, message } = result;

    if (!ok) {
      const lintMessage = `${uri} is dead. (${message})`;

      report(node, new RuleError(lintMessage, { index }));
    } else if (redirected) {
      const lintMessage = `${uri} is redirected to ${redirectTo}. (${message})`;
      const fix = fixer.replaceTextRange(
        [index, index + uri.length],
        redirectTo,
      );

      report(node, new RuleError(lintMessage, { fix, index }));
    }
  };

  /**
   * URIs to be checked.
   * @type {Array<{ node: TextLintNode, uri: string, index: number }>}
   */
  const URIs = [];

  return {
    [Syntax.Str](node) {
      if (helper.isChildNode(node, [Syntax.BlockQuote])) {
        return;
      }

      // prevent double checks
      if (helper.isChildNode(node, [Syntax.Link])) {
        return;
      }

      const text = getSource(node);

      // Use `String#replace` instead of `RegExp#exec` to allow us
      // perform RegExp matches in an iterate and immutable manner
      text.replace(URI_REGEXP, (uri, index) => {
        URIs.push({ node, uri, index });
      });
    },

    [Syntax.Link](node) {
      if (helper.isChildNode(node, [Syntax.BlockQuote])) {
        return;
      }

      // Ignore HTML5 place holder link.
      // Ex) <a>Placeholder Link</a>
      if (typeof node.url === 'undefined') {
        return;
      }

      // [text](http://example.com)
      //       ^
      const index = node.raw.indexOf(node.url) || 0;

      URIs.push({
        node,
        uri: node.url,
        index,
      });
    },

    [`${context.Syntax.Document}:exit`]() {
      return Promise.all(URIs.map((item) => lint(item)));
    },
  };
}

export default {
  linter: reporter,
  fixer: reporter,
};
