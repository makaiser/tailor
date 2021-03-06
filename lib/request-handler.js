'use strict';
const AsyncStream = require('./streams/async-stream');
const LinkHeader = require('http-link-header');
const ContentLengthStream = require('./streams/content-length-stream');
const FRAGMENT_EVENTS = [
    'start',
    'response',
    'end',
    'error',
    'timeout',
    'fallback',
    'warn'
];
const { TEMPLATE_NOT_FOUND } = require('./fetch-template');

const processTemplate = require('./process-template');

const getCrossOriginHeader = (fragmentUrl, host) => {
    if (host && fragmentUrl.indexOf(`://${host}`) < 0) {
        return 'crossorigin';
    }
    return '';
};

// Early preloading of primary fragments assets to improve Performance
const getAssetsToPreload = ({ link }, { headers = {} }) => {
    let assetsToPreload = [];

    const { refs = [] } = LinkHeader.parse(link);
    const scriptRefs = refs
        .filter(ref => ref.rel === 'fragment-script')
        .map(ref => ref.uri);
    const styleRefs = refs
        .filter(ref => ref.rel === 'stylesheet')
        .map(ref => ref.uri);

    // Handle Server rendered fragments without depending on assets
    if (!scriptRefs[0] && !styleRefs[0]) {
        return '';
    }
    styleRefs.forEach(uri => {
        assetsToPreload.push(`<${uri}>; rel="preload"; as="style"; nopush`);
    });
    scriptRefs.forEach(uri => {
        const crossOrigin = getCrossOriginHeader(uri, headers.host);
        assetsToPreload.push(
            `<${uri}>; rel="preload"; as="script"; nopush; ${crossOrigin}`
        );
    });
    return assetsToPreload.join(',');
};

function nextIndexGenerator(initialIndex, step) {
    let index = initialIndex;

    return () => {
        let pastIndex = index;
        index += step;
        return pastIndex;
    };
}

/**
 * Process the HTTP Request to the Tailor Middleware
 *
 * @param {Object} options - Options object passed to Tailor
 * @param {Object} request - HTTP request stream of Middleware
 * @param {Object} response - HTTP response stream of middleware
 */
module.exports = function processRequest(options, request, response) {
    this.emit('start', request);
    const {
        fetchContext,
        fetchTemplate,
        parseTemplate,
        filterResponseHeaders,
        maxAssetLinks
    } = options;

    const asyncStream = new AsyncStream();
    asyncStream.once('plugged', () => {
        asyncStream.end();
    });

    const contextPromise = fetchContext(request).catch(err => {
        this.emit('context:error', request, err);
        return {};
    });
    const templatePromise = fetchTemplate(request, parseTemplate);
    const responseHeaders = {
        // Disable cache in browsers and proxies
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        'Content-Type': 'text/html'
    };

    let shouldWriteHead = true;

    const contentLengthStream = new ContentLengthStream(contentLength => {
        this.emit('end', request, contentLength);
    });

    const handleError = err => {
        this.emit('error', request, err);
        if (shouldWriteHead) {
            shouldWriteHead = false;
            let statusCode = 500;
            if (err.code === TEMPLATE_NOT_FOUND) {
                statusCode = 404;
            }

            response.writeHead(statusCode, responseHeaders);
            // To render with custom error template
            if (typeof err.presentable === 'string') {
                response.end(`${err.presentable}`);
            } else {
                response.end();
            }
        } else {
            contentLengthStream.end();
        }
    };

    const handlePrimaryFragment = (fragment, resultStream) => {
        if (!shouldWriteHead) {
            return;
        }

        shouldWriteHead = false;

        fragment.once('response', (statusCode, headers) => {
            // Map response headers
            if (typeof filterResponseHeaders === 'function') {
                Object.assign(
                    responseHeaders,
                    filterResponseHeaders(fragment.attributes, headers)
                );
            }

            if (headers.location) {
                responseHeaders.location = headers.location;
            }

            // Make resources early discoverable while processing HTML
            const preloadAssets = headers.link
                ? getAssetsToPreload(headers, request)
                : '';
            if (preloadAssets !== '') {
                responseHeaders.link = preloadAssets;
            }
            this.emit('response', request, statusCode, responseHeaders);

            response.writeHead(statusCode, responseHeaders);
            resultStream.pipe(contentLengthStream).pipe(response);
        });

        fragment.once('fallback', err => {
            this.emit('error', request, err);
            response.writeHead(500, responseHeaders);
            resultStream.pipe(contentLengthStream).pipe(response);
        });

        fragment.once('error', err => {
            this.emit('error', request, err);
            response.writeHead(500, responseHeaders);
            response.end();
        });
    };

    Promise.all([templatePromise, contextPromise])
        .then(([parsedTemplate, context]) => {
            // extendedOptions are mutated inside processTemplate
            const extendedOptions = Object.assign({}, options, {
                nextIndex: nextIndexGenerator(0, maxAssetLinks),
                asyncStream
            });

            const resultStream = processTemplate(
                request,
                extendedOptions,
                context
            );

            resultStream.on('fragment:found', fragment => {
                FRAGMENT_EVENTS.forEach(eventName => {
                    fragment.once(eventName, (...args) => {
                        const prefixedName = 'fragment:' + eventName;
                        this.emit(
                            prefixedName,
                            request,
                            fragment.attributes,
                            ...args
                        );
                    });
                });

                const { primary } = fragment.attributes;
                primary && handlePrimaryFragment(fragment, resultStream);
            });

            resultStream.once('finish', () => {
                const statusCode = response.statusCode || 200;
                if (shouldWriteHead) {
                    shouldWriteHead = false;
                    this.emit('response', request, statusCode, responseHeaders);
                    response.writeHead(statusCode, responseHeaders);
                    resultStream.pipe(contentLengthStream).pipe(response);
                }
            });

            resultStream.once('error', handleError);

            parsedTemplate.forEach(item => {
                resultStream.write(item);
            });
            resultStream.end();
        })
        .catch(err => {
            handleError(err);
        });
};
