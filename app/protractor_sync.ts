/* tslint:disable: no-var-requires no-eval */

'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as ab from 'asyncblock';
import * as mkdirp from 'mkdirp';

import { ElementFinder, Key, WebElement, ProtractorBy, ProtractorBrowser } from 'protractor';
import { Locator } from 'protractor/built/locators';
import { ILocation, ISize, IWebElementId } from 'selenium-webdriver';

import baseDir = require('../base_dir');

export var IMPLICIT_WAIT_MS = 5000;
export var RETRY_INTERVAL = 10;

export var LARGE_BREAKPOINT_WIDTH = 1366;
export var MEDIUM_BREAKPOINT_WIDTH = 768;
// Ideally we'd like the small breakpoint to be 320px to mimic older smart phones.  We've found that this has not been practical (chrome
// on mac will set a minimum with of around 400px if you go lower than that, and chrome on linux stops showing the window all together if
// you go below the minimum).  550px currently works on the build server, so until we find a work-around, we'll stick with that.
export var SMALL_BREAKPOINT_WIDTH = 550;

export var DEFAULT_BREAKPOINT_WIDTH = LARGE_BREAKPOINT_WIDTH;
export var DEFAULT_BREAKPOINT_HEIGHT = 1024;

export var CLICK_RETRY_INTERVAL = 200;

export var autoReselectStaleElements = true;
export var autoRetryClick = true;

export const by = (global as any).by;
export const element = (global as any).element;
export const browser = (global as any).browser;

/**
 * Executes a function repeatedly until it returns a value other than undefined. Waits RETRY_INTERVAL ms between function calls.
 *
 * @param fn The function to execute repeatedly
 * @param onTimeout An optional function to call when fn doesn't return a defined value before IMPLICIT_WAIT_MS.
 *                  If this is not specified then a generic exception will be raised.
 * @param waitTimeMs Override the amount of time to wait before timing out
 * @returns {any} The last value the function returned, as long as it did not time out
 */
function _polledWait(
  fn: () => { keepPolling: boolean; data: any; },
  onTimeout?: (data: any) => void,
  waitTimeMs?: number
) {
  var startTime = new Date();
  var timeout = waitTimeMs != null ? waitTimeMs : IMPLICIT_WAIT_MS;
  var result: any;
  var flow = ab.getCurrentFlow();

  while (true) {
    if (result == null || new Date().getTime() - startTime.getTime() < timeout) {
      result = fn();

      if (result.keepPolling) {
        flow.sync(setTimeout(flow.add(), RETRY_INTERVAL)); //Wait a bit before checking again
      } else {
        break;
      }
    } else {
      if (onTimeout) {
        onTimeout(result.data);
        break;
      } else {
        throw new Error('Timed out(' + timeout + ') waiting for function: ' + (<any>fn).name);
      }
    }
  }

  return result.data;
}

/**
 * Selects an element or elements. This function is not intended to be called directly (use findVisible, findVisibles, findElement, etc.)
 *
 * @param args.selector A css selector or locator used to select the element(s)
 * @param args.shouldExist True if we expect the element to be found, false otherwise
 * @param args.single True if we're only selecting one element, false otherwise
 * @param args.requireVisible True if the elements must be visible
 * @param args.rootElement Constrain selection to descendants of this element only
 * @returns {protractor.ElementFinder[]}
 * @private
 */
function _getElements(
  args: {
    selector: any;
    shouldExist: boolean;
    single: boolean;
    requireVisible: boolean;
    rootElement: ElementFinderSync;
    poll: boolean
  }
) {
  function extractResult(elements: ElementFinder[]) {
    var filteredCount = elements && elements.length || 0;

    if (!args.shouldExist) {
      if (filteredCount === 0) {
        return { keepPolling: false, data: [] };
      }
    } else {
      if (args.single && filteredCount === 1) {
        return { keepPolling: false, data: elements };
      } else if (!args.single && filteredCount > 0) {
        return { keepPolling: false, data: elements };
      }
    }

    return { keepPolling: true, data: elements };
  }

  function onTimeout(elements: ElementFinder[]) {
    var filteredCount = elements && elements.length || 0;

    if (!args.shouldExist && filteredCount > 0) {
      throw new Error(args.selector + ' was found when it should not exist!');
    }

    if (filteredCount === 0) {
      if (args.requireVisible) {
        throw new Error('No visible instances of (' + args.selector + ') were found');
      } else {
        throw new Error('No instances of (' + args.selector + ') were found');
      }
    } else if (args.single && filteredCount > 1) {
      if (args.requireVisible) {
        throw new Error('More than one visible instance of (' + args.selector + ') was found!');
      } else {
        throw new Error('More than one instance of (' + args.selector + ') was found!');
      }
    }
  }

  var locator = args.selector;
  if (typeof args.selector === 'string') {
    locator = by.css(args.selector);
  }

  var flow = ab.getCurrentFlow();

  return _polledWait(() => {
    var elements: any;
    var filtered: ElementFinder[];

    if (args.rootElement) {
      elements = (<any>args.rootElement.getElementFinder()).all(locator);
    } else {
      elements = (<any>element).all(locator);
    }

    //Force the elements to resolve immediately (we want to make sure elements selected with findElement are present before continuing)
    var resolveElementsCb = flow.add();
    var resolved: any[] = [];

    try {
      resolved = flow.sync(elements.getWebElements().then(function (result: any) {
        resolveElementsCb(null, result);
      }, function (err: any) {
        resolveElementsCb(err);
      }));
    } catch (e) {
      if (autoReselectStaleElements && e.name === 'StaleElementReferenceError' && args.rootElement) {
        //Try with the new root element on the next poll
        args.rootElement = args.rootElement.reselect();
      } else {
        throw e;
      }
    }

    //Convert from an array of selenium web elements to an array of protractor element finders
    resolved = resolved.map((webElement: any, i: number) => {
      var elementFinder = ElementFinderSync.fromWebElement_(elements.browser_, webElement, locator);
      //TODO: clean up
      elementFinder.__psync_selection_args = args;
      elementFinder.__psync_selection_ordinal = i;
      return elementFinder;
    });

    if (args.requireVisible) {
      filtered = resolved.filter((element: ElementFinderSync) => {
        try {
          return element.isDisplayed();
        } catch (e) {
          //If the element has been removed from the DOM between when it was selected and now,
          //don't treat it as an error and fail the test.
          //Instead we will keep polling until we get a stable reference.
          if (e.name === 'StaleElementReferenceError') {
            return false;
          } else {
            throw e;
          }
        }
      });
    } else {
      filtered = resolved;
    }

    return extractResult(filtered);
  }, onTimeout, args.poll ? IMPLICIT_WAIT_MS : 0);
}

/**
 * Asserts that an element is NOT present. Polls in order to give the element time to disappear from the DOM.
 * If time expires and the element is still present, an error will be thrown.
 * @param selector A CSS selector or element locator
 * @param rootElement If specified, only search for descendants of this element
 * @returns true if there are no matching elements
 */
function assertElementDoesNotExist(selector: any, rootElement?: ElementFinderSync) {
  var elements: any[] = [];

  elements = _getElements({
    selector: selector,
    shouldExist: false,
    rootElement: rootElement,
    poll: true,
    requireVisible: false,
    single: false
  });

  return elements.length === 0;
}

/**
 * Returns the active element on the page
 */
function getActiveElement() {
  var active = browser.executeScript(function() {
    return document.activeElement;
  });

  return ElementFinder.fromWebElement_(browser, active);
}

/**
 * Finds a single visible instance of an element. If more than one visible elements match the locator,
 * and error is thrown. If no visible elements match the locator, an error is thrown. Implicitly waits until there is exactly one
 * visible element.
 *
 * @param selector A CSS selector or element locator
 * @param rootElement If specified, only find descendants of this element
 * @returns {ElementFinder}
 */
function findVisible(selector: any, rootElement?: ElementFinderSync): ElementFinderSync {
  var displayed = _getElements({
    selector: selector,
    shouldExist: true,
    single: true,
    requireVisible: true,
    rootElement: rootElement,
    poll: true
  });

  return displayed[0];
}

/**
 * Finds multiple visible elements. If no visible elements match the locator, an error is thrown.
 * Implicitly waits until at least one visible element is found.
 *
 * @param selector A CSS selector or element locator
 * @param rootElement If specified, only find descendants of this element
 * @returns {ElementFinder[]}
 */
function findVisibles(selector: any, rootElement?: ElementFinderSync): ElementFinderSync[] {
  var displayed = _getElements({
    selector: selector,
    shouldExist: true,
    single: false,
    requireVisible: true,
    rootElement: rootElement,
    poll: true
  });

  return displayed;
}

/**
 * Finds a single element. If no elements match the locator, an error is thrown.
 * Implicity waits until one element is found.
 *
 * @param selector A CSS selector or element locator
 * @param rootElement If specified, only find descendants of this element
 * @returns {ElementFinder}
 */
function findElement(selector: any, rootElement?: ElementFinderSync): ElementFinderSync {
  var elements = _getElements({
    selector: selector,
    shouldExist: true,
    single: true,
    requireVisible: false,
    rootElement: rootElement,
    poll: true
  });

  return elements[0];
}

/**
 * Finds multiple elements. If no elements match the locator, an error is thrown.
 * Implicitly waits until at least one element is found.
 *
 * @param selector A CSS selector or element locator
 * @param rootElement If specified, only find descendants of this element
 * @returns {ElementFinder}
 */

function findElements(selector: any, rootElement?: ElementFinderSync): ElementFinderSync[] {
  var elements = _getElements({
    selector: selector,
    shouldExist: true,
    single: false,
    requireVisible: false,
    rootElement: rootElement,
    poll: true
  });

  return elements;
}

/**
 * Extend global element variable
 */
function patchGlobals() {
  patchBrowser();
}

function patchBrowser() {
  if (!browser.__psync_patched) {
    patchWithExec(browser, ['getAllWindowHandles']);
    //TODO: 'get'
    patchWithExec(browser.driver, ['executeScript', 'executeAsyncScript', 'sleep', /*'get',*/ 'getCurrentUrl', 'close',
                                   'quit', 'getWindowHandle']);

    var targetLocatorPrototype = Object.getPrototypeOf(browser.switchTo());
    patchWithExec(targetLocatorPrototype, ['window', 'defaultContent']);

    browser.waitFor = function(condition: () => boolean, waitTimeMs?: number) {
      _polledWait(() => {
        return {data: <any>null, keepPolling: !condition()};
      }, null, waitTimeMs);
    };

    var PAUSE_DEBUGGER_DELAY_MS = 500;
    _patch(browser, ['pause', 'debugger'], null, (returnValue: any) => {
      var flow = ab.getCurrentFlow();
      if (flow) {
        //Sometimes pause and debugger don't work without a delay before executing the next command
        flow.sync(setTimeout(flow.add(), PAUSE_DEBUGGER_DELAY_MS));
      }

      return returnValue;
    });

    browser.__psync_patched = true;
  }

  var managePrototype = Object.getPrototypeOf(browser.manage());
  if (!managePrototype.__psync_patched) {
    patchWithExec(
      managePrototype,
      ['addCookie', 'deleteAllCookies', 'deleteCookie', 'getCookies', 'getCookie']
    );

    managePrototype.__psync_patched = true;
  }
}

function _patch(obj: any, methods: string[], pre: () => void, post: (returnValue: any) => any) {
  var patches = Object.create(null);

  methods.forEach(func => {
    patches[func] = obj[func];

    obj[func] = function () {
      if (pre) {
        pre.call(this);
      }

      var returnValue = patches[func].apply(this, arguments);

      if (post) {
        returnValue = post.call(this, returnValue);
      }

      return returnValue;
    };
  });
}

function patchWithExec(proto: any, methods: string[]) {
  _patch(proto, methods, null, returnValue => {
    if (returnValue && returnValue.then && ab.getCurrentFlow()) {
      return exec(returnValue);
    } else {
      return returnValue;
    }
  });
}

function exec(obj: any) {
  if (obj.then) {
    var flow = ab.getCurrentFlow();
    var cb = flow.add();

    return flow.sync(obj.then(function (result: any) {
      if (result instanceof ElementFinder) {
        result = new ElementFinderSync(result);
      }

      cb(null, result);
    }, function (err: any) {
      cb(err);
    }));
  } else {
    return obj;
  }
}

function retryOnStale(obj: any, func: string) {
  var original = obj[func];

  return function attempt() {
    try {
      return original.apply(this, arguments);
    } catch (e) {
      if (e.name === 'StaleElementReferenceError') {
        var reselected = this.reselect();

        return reselected[func].apply(reselected, arguments);
      } else {
        throw e;
      }
    }
  };
}

/**
 * Apply synchronous patches to protractor
 */
export function patch() {
  patchGlobals();
}

export var disallowMethods = (function () {
  var ALLOWED_LOCATIONS = ['node_modules', 'protractor_sync.'];

  function disableMethod(object: any, method: string, extraInfo?: string) {
    if (object[method] == null) {
      throw new Error('Cannot disable ' + method + '(). It does not exist');
    }

    var original = object[method];
    object[method] = function () {
      // We don't want to block access from protractor or selenium or the current file
      var stack = (<any>new Error()).stack;

      //First line is the error message, second line is where the error was created, third line is the caller
      var secondFrame = stack.split('\n')[2];

      if (ALLOWED_LOCATIONS.every(location => secondFrame.indexOf(location) < 0)) {
        throw new Error(method + '() has been disabled in this project! ' + (extraInfo || ''));
      } else {
        return original.apply(this, arguments);
      }
    };
  }

  return (options?: { expect: boolean; }) => {
    var SELECTOR_GLOBAL_SINGLE_ADVICE = 'Use element.findVisible() or element.findElement() instead.';
    var SELECTOR_GLOBAL_MULTI_ADVICE = 'Use element.findVisibles() or element.findElements() instead.';
    var SLEEP_ADVICE = 'Use browser.waitFor(), element.waitUntil(), element.waitUntilRemove() etc. instead of browser.sleep().';
    var WAIT_ADVICE = 'Use browser.waitFor() instead.';
    var EXPECT_ADVICE = 'Use polledExpect instead of expect.';

    disableMethod(browser, '$', SELECTOR_GLOBAL_SINGLE_ADVICE);
    disableMethod(browser, '$$', SELECTOR_GLOBAL_MULTI_ADVICE);
    disableMethod(browser, 'element', SELECTOR_GLOBAL_SINGLE_ADVICE);

    disableMethod(browser.driver, 'wait', WAIT_ADVICE);
    disableMethod(browser.driver, 'findElement', SELECTOR_GLOBAL_SINGLE_ADVICE);
    disableMethod(browser.driver, 'findElements', SELECTOR_GLOBAL_MULTI_ADVICE);
    disableMethod(browser.driver, 'sleep', SLEEP_ADVICE);

    disableMethod(browser, 'wait', WAIT_ADVICE);
    disableMethod(browser, 'findElement', SELECTOR_GLOBAL_SINGLE_ADVICE);
    disableMethod(browser, 'findElements', SELECTOR_GLOBAL_MULTI_ADVICE);
    disableMethod(browser, 'sleep', SLEEP_ADVICE);

    if (options && options.expect) {
      disableMethod(global, 'expect', EXPECT_ADVICE);
    }

    var LOCATOR_ADVICE = 'Use a css selector or by.model instead.';

    [
      'binding',
      'className',
      'css',
      'cssContainingText',
      'deepCss',
      'exactBinding',
      'exactRepeater',
      'id',
      'js',
      'name',
      'options',
      'partialButtonText',
      'repeater',
      'tagName',
      'xpath'
    ].forEach(locator => {
      disableMethod(by, locator, LOCATOR_ADVICE);
    });
  };
})();

export function waitForNewWindow(action: Function, waitTimeMs?: number) {
  var handlesBefore: string[] = (<any>browser).getAllWindowHandles();
  var handles: string[];

  action();

  browser.waitFor(() => {
    handles = (<any>browser).getAllWindowHandles();
    return handles.length === handlesBefore.length + 1;
  }, waitTimeMs);

  var newWindowHandle = handles[handles.length - 1];

  browser.switchTo().window(newWindowHandle);

  browser.waitFor(() => {
    return (<any>browser.driver).getCurrentUrl() !== '';
  }, waitTimeMs);
}

export function polledExpect(func: Function, waitTimeMS?: number) {
  const timeout = waitTimeMS || IMPLICIT_WAIT_MS;
  const startTime = new Date().getTime();
  const matchers = Object.create(null);
  const flow = ab.getCurrentFlow();
  const originalContext = new Error();
  let isNot = false;
  let matcherCalled = false;

  setTimeout(() => {
    if (!matcherCalled) {
      originalContext.message = 'polledExpect() was called without calling a matcher';
      console.error((<any>originalContext).stack);

      //There's no way to fail the current test because the afterEach has already run by this point
      //Exiting the process is the only way to guarantee a developer will notice the problem
      process.exit(1);
    }
  });

  Object.keys((<any>jasmine).matchers).forEach(key => {
    matchers[key] = function(expected: any) {
      matcherCalled = true;
      let passed = false;

      do {
        const actual = func();
        const result = (<any>jasmine).matchers[key]((<any>jasmine).matchersUtil, null).compare(actual, expected);
        passed = result.pass;

        if (isNot) {
          passed = !passed;
        }

        if (!passed) {
          if (new Date().getTime() - startTime <= timeout) {
            setTimeout(flow.add(), RETRY_INTERVAL);
          } else {
            let message = result.message;

            if (!message) {
              message = (<any>jasmine).matchersUtil.buildFailureMessage(key, isNot, actual, expected);
            }

            throw new Error(message);
          }
        }
      } while (!passed);
    };
  });

  Object.defineProperty(matchers, 'not', {
    get: function() {
      isNot = true;

      return matchers;
    }
  });

  return matchers;
}

//Expose global variable so callers can call "polledExpect" similar to just calling "expect"
(global as any).polledExpect = polledExpect;

/**
 * Takes a screenshot and saves a .png file in the configured screenshot directory.
 *
 * @param filename The name of the file to save
 */
export function takeScreenshot(filename: string) {
  if (filename) {
    var basePath = path.dirname(filename);
    if (!fs.existsSync(basePath)) {
      mkdirp.sync(basePath);
    }

    if (!(/\.png$/i).test(filename)) {
      filename += '.png';
    }
  }

  var flow = ab.getCurrentFlow();
  var callback = flow.add();
  return flow.sync(browser.takeScreenshot().then((base64png: string) => {
    if (filename) {
      fs.writeFileSync(filename, base64png, 'base64');
    }
    return callback(null, base64png);
  }, callback));
}

function calculateDimension(dimension: number, window: number, viewport: number) {
  return dimension + (window - viewport);
}

export function resizeViewport(size: { width?: number; height?: number; }) {
  var flow = ab.getCurrentFlow();

  var windowSize = flow.sync(browser.manage().window().getSize().then(flow.add({firstArgIsError: false})));
  var viewportSize: any = browser.executeScript(function () {
    return {
      height: window.document.documentElement.clientHeight,
      width: window.document.documentElement.clientWidth
    };
  });

  var calcWidth = (width: number) => calculateDimension(width, windowSize.width, viewportSize.width);
  var calcHeight = (height: number) => calculateDimension(height, windowSize.height, viewportSize.height);

  var width = windowSize.width;
  var height = windowSize.height;

  if (size) {
    width = calcWidth(size.width || DEFAULT_BREAKPOINT_WIDTH);
    height = calcHeight(size.height || DEFAULT_BREAKPOINT_HEIGHT);
  } else if (windowSize.width < DEFAULT_BREAKPOINT_WIDTH) {
    width = calcWidth(DEFAULT_BREAKPOINT_WIDTH);
  } else {
    // No size set and width is wider than the minimum.  We can return early without resizing the browser
    return;
  }

  flow.sync(browser.manage().window().setSize(width, height).then(flow.add()));
}

export function configure(args: { implicitWaitMs: number }) {
  IMPLICIT_WAIT_MS = args.implicitWaitMs || IMPLICIT_WAIT_MS;
}

export class ElementFinderSync {
  public __psync_selection_args: any;
  public __psync_selection_ordinal: number;

  constructor(private element: ElementFinder) {

  }

  findVisible(selector: string | ProtractorBy) {
    return findVisible(selector, this);
  }

  findVisibles(selector: string | ProtractorBy) {
    return findVisibles(selector, this);
  }

  findElement(selector: string | ProtractorBy) {
    return findElement(selector, this);
  }

  findElements(selector: string | ProtractorBy) {
    return findElements(selector, this);
  }

  assertElementDoesNotExist(selector: string | ProtractorBy) {
    return assertElementDoesNotExist(selector, this);
  }

  getElementFinder() {
    return this.element;
  }

  getSelectionPath() {
    var path = '';
    var args = this.__psync_selection_args;
    if (args) {
      if (args.rootElement) {
        path += args.rootElement.getSelectionPath() + ' -> ';
      }

      if (args.selector) {
        path += args.selector;
      } else if (args.method) {
        path += args.method + '(' + (args.arg || '') + ')';
      }

      if (this.__psync_selection_ordinal > 0 || args.single === false) {
        path += '[' + this.__psync_selection_ordinal + ']';
      }
    }

    return path;
  };

  reselect(): ElementFinderSync {
    var args = this.__psync_selection_args;
    if (args) {
      var elements: ElementFinderSync[];

      if (args.selector) {
        console.log('(Protractor-sync): Re-selecting stale element: ' + this.getSelectionPath());

        elements = _getElements(args);
      } else if (args.method) {
        console.log('(Protractor-sync): Re-selecting stale element: ' + this.getSelectionPath());

        elements = args.rootElement[args.method](args.arg);
      } else {
        console.error('(Protractor-sync): Attempting to re-select stale element, but selection info is incomplete');
      }

      if (Array.isArray(elements)) {
        return elements[this.__psync_selection_ordinal];
      } else {
        return elements;
      }
    } else {
      console.error('(Protractor-sync): Attempting to re-select stale element, but selection info is missing');
    }
  };

  //Polled waiting

  waitUntil(condition: string) {
    _polledWait(() => {
      var val = this.element.browser_.executeScript(function (element: HTMLElement, condition: string) {
        return (<any>window).$(element).is(condition);
      }, this.element , condition);

      return {data: <any>null, keepPolling: !val};
    }, () => {
      throw new Error('Timed out(' + IMPLICIT_WAIT_MS + ') waiting for condition: ' + condition);
    });

    return this;
  }

  waitUntilRemoved() {
    _polledWait(() => {
      return { data: <any>null, keepPolling: this.isPresent() };
    }, () => {
      throw new Error('Timed out(' + IMPLICIT_WAIT_MS + ') waiting for element to be removed');
    });

    return this;
  }

  //ElementFinder methods

  isPresent(): boolean {
    return exec(this.element.isPresent());
  }

  static fromWebElement_(browser: ProtractorBrowser, webElem: WebElement, locator?: Locator) {
    return new ElementFinderSync(ElementFinder.fromWebElement_(browser, webElem, locator));
  }

  evaluate(expression: string): ElementFinderSync {
    return this.runWithStaleDetection(() => exec(this.element.evaluate(expression)));
  }

  allowAnimations(value: boolean): ElementFinderSync {
    return this.runWithStaleDetection(() => exec(this.element.allowAnimations(value)));
  }

  isElementPresent(subLocator: Locator): boolean {
    return this.runWithStaleDetection(() => exec(this.element.isElementPresent(subLocator)));
  }

  click(): ElementFinderSync {
    var startTime = new Date().getTime();

    var attempt: any = () => {
      try {
        exec(this.element.click());
      } catch (e) {
        if (autoRetryClick && /Other element would receive the click/.test(e.message) && new Date().getTime() - startTime < IMPLICIT_WAIT_MS) {
          console.log('(Protractor-sync): Element (' + this.getSelectionPath() + ') was covered, retrying click.');

          var flow = ab.getCurrentFlow();
          flow.sync(setTimeout(flow.add(), CLICK_RETRY_INTERVAL)); //We don't need this to retry as quickly

          return attempt();
        } else {
          throw e;
        }
      }
    };

    this.runWithStaleDetection(() => attempt());

    return this;
  }

  sendKeys(...var_args: Array<string | number>): ElementFinderSync {
    this.runWithStaleDetection(() => exec(this.element.sendKeys.apply(this.element, var_args)));

    return this;
  }

  getTagName(): string {
    return this.runWithStaleDetection(() => exec(this.element.getTagName()));
  }

  getCssValue(cssStyleProperty: string): string {
    return this.runWithStaleDetection(() => exec(this.element.getCssValue(cssStyleProperty)));
  }

  getAttribute(attributeName: string): string {
    return this.runWithStaleDetection(() => exec(this.element.getAttribute(attributeName)));
  }

  getText(): string {
    return this.runWithStaleDetection(() => exec(this.element.getText()));
  }

  getSize(): ISize {
    return this.runWithStaleDetection(() => exec(this.element.getSize()));
  }

  getLocation(): ILocation {
    return this.runWithStaleDetection(() => exec(this.element.getLocation()));
  }

  isEnabled(): boolean {
    return this.runWithStaleDetection(() => exec(this.element.isEnabled()));
  }

  isSelected(): boolean {
    return this.runWithStaleDetection(() => exec(this.element.isSelected()));
  }

  submit(): ElementFinderSync {
    this.runWithStaleDetection(() => exec(this.element.submit()));

    return this;
  }

  clear(): ElementFinderSync {
    this.runWithStaleDetection(() => exec(this.element.clear()));

    return this;
  }

  isDisplayed(): boolean {
    return this.runWithStaleDetection(() => exec(this.element.isDisplayed()));
  }

  takeScreenshot(opt_scroll?: boolean): string {
    return this.runWithStaleDetection(() => exec(this.element.takeScreenshot(opt_scroll)));
  }

  getOuterHtml(): string {
    return this.runWithStaleDetection(() => exec(this.element.getOuterHtml()));
  }

  getInnerHtml(): string {
    return this.runWithStaleDetection(() => exec(this.element.getInnerHtml()));
  }

  serialize(): IWebElementId {
    return this.runWithStaleDetection(() => exec(this.element.serialize()));
  }

  getId(): string {
    return this.runWithStaleDetection(() => exec(this.element.getId()));
  }

  //JQuery methods

  executeJQueryElementMethod(method: string, arg?: any): any {
    var attempt: () => Promise<any> | string = () => {
      return exec(browser.executeScript(function (element: HTMLElement, method: string, arg: any) {
        var $ = (<any>window).jQuery;

        if (!$) {
          return '!!jquery not present!!';
        }

        var result = arg ? $(element)[method](arg) : $(element)[method]();

        if (result instanceof (<any>window).jQuery) {
          return result.toArray();
        } else {
          return result;
        }
      }, this.element, method, arg));
    };

    var result = this.runWithStaleDetection(() => attempt());

    if (result === '!!jquery not present!!') {
      throw Error('jQuery not present, unable to continue');
    }

    if (Array.isArray(result)) {
      return result.map((webElement: any, i: number) => {
        var elementFinder = ElementFinderSync.fromWebElement_(this.element.browser_, webElement);

        //TODO: clean up
        elementFinder.__psync_selection_args = {
          rootElement: this,
          method: method,
          arg: arg
        };
        elementFinder.__psync_selection_ordinal = i;

        return elementFinder;
      });
    } else {
      return result;
    }
  }

  closest(selector: string): ElementFinderSync {
    return this.executeJQueryElementMethod('closest', selector)[0];
  }

  hasClass(className: string): boolean {
    return this.runWithStaleDetection(() => exec(this.element.browser_.executeScript(function (element: HTMLElement, className: string) {
      return element.classList.contains(className);
    }, this.element, className)));
  }

  isFocused(): boolean {
    return this.runWithStaleDetection(() => exec(this.element.browser_.executeScript(function(element: HTMLElement) {
      return document.activeElement === element;
    }, this.element)));
  }

  innerHeight(): number {
    return this.executeJQueryElementMethod('innerHeight');
  }

  innerWidth(): number {
    return this.executeJQueryElementMethod('innerWidth');
  }

  is(selector: string): boolean {
    return this.executeJQueryElementMethod('is', selector);
  }

  outerHeight(includeMargin?: boolean) {
    return this.executeJQueryElementMethod('outerHeight', includeMargin);
  }

  outerWidth(includeMargin?: boolean) {
    return this.executeJQueryElementMethod('outerWidth', includeMargin);
  };

  next(selector?: string): ElementFinderSync {
    return this.executeJQueryElementMethod('next', selector)[0];
  };

  offset(): { top: number; left: number } {
    return this.executeJQueryElementMethod('offset');
  };

  parent(selector?: string): ElementFinderSync {
    return this.executeJQueryElementMethod('parent', selector)[0];
  };

  parents(selector?: string): ElementFinderSync[] {
    return this.executeJQueryElementMethod('parents', selector);
  }

  position(): { top: number; left: number } {
    return this.executeJQueryElementMethod('position');
  }

  prev(selector?: string): ElementFinderSync {
    return this.executeJQueryElementMethod('prev', selector)[0];
  }

  prop(name: string): string | number | boolean {
    return this.executeJQueryElementMethod('prop', name);
  }

  sendEnterKey(): ElementFinderSync {
    this.sendKeys(Key.ENTER);

    return this;
  }

  sendTabKey(): ElementFinderSync {
    this.sendKeys(Key.TAB);

    return this;
  }

  scrollLeft(): number {
    return this.executeJQueryElementMethod('scrollLeft');
  }

  scrollTop(): number {
    return this.executeJQueryElementMethod('scrollTop');
  }

  scrollIntoView(): ElementFinderSync {
    this.runWithStaleDetection(() => browser.executeScript(function (element: HTMLElement) {
      element.scrollIntoView();
    }, this.element));

    return this;
  }

  private runWithStaleDetection<T>(func: () => T): T {
    const attempt: () => T = () => {
      try {
        return func();
      } catch (e) {
        if (e.name === 'StaleElementReferenceError') {
          this.element = this.reselect().getElementFinder();

          return attempt();
        } else {
          throw e;
        }
      }
    };

    return attempt();
  }
}

export const elementSync = {
  findVisible,
  findVisibles,

  findElement,
  findElements,

  assertElementDoesNotExist,

  getActiveElement
};