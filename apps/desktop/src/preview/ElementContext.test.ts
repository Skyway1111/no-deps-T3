import { expect, it } from "vite-plus/test";

import { getElementContext } from "./ElementContext.ts";

const mount = (html: string) => {
  document.body.innerHTML = html;
  return (selector: string) => document.querySelector(selector)!;
};

it("reads React 18 debug sources up the owner chain through ForwardRef and Memo", () => {
  const $ = mount(`<main><button class="primary" style="padding-top: 4px">Save</button></main>`);
  function Page() {}
  const Button = { render: function ButtonImpl() {} };
  const owner = {
    type: { type: Button },
    _debugSource: { fileName: "/src/Page.tsx", lineNumber: 9, columnNumber: 3 },
    _debugOwner: { type: Page },
    return: { type: Page },
  };
  // An owner loop must not hang the pick.
  Object.assign(owner._debugOwner, { _debugOwner: owner });
  Object.assign($("button"), {
    __reactFiber$x1: {
      type: "button",
      return: owner,
      _debugOwner: owner,
      _debugSource: { fileName: "/src/Button.tsx", lineNumber: 4, columnNumber: 10 },
    },
  });

  const context = getElementContext($("button"));

  expect(context.componentName).toBe("ButtonImpl");
  expect(context.stack).toEqual([
    { functionName: "ButtonImpl", fileName: "/src/Button.tsx", lineNumber: 4, columnNumber: 10 },
    { functionName: "Page", fileName: "/src/Page.tsx", lineNumber: 9, columnNumber: 3 },
    { functionName: "ButtonImpl", fileName: null, lineNumber: null, columnNumber: null },
  ]);
  expect(context.source).toEqual(context.stack[0]);
  expect(context.selector).toBe("button");
  expect(context.htmlPreview).toContain("<button");
  expect(context.styles).toBe("className: primary\n\npadding-top: 4px;");
});

it("takes the JSX call site from a React 19 debug stack, skipping React's own frames", () => {
  const $ = mount(`<span>a</span><span>b</span>`);
  Object.assign($("span:last-child"), {
    __reactFiber$x2: {
      type: "span",
      _debugStack: {
        stack: [
          "Error: react-stack-top-frame",
          "    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)",
          "    at List (http://localhost:5173/src/List.tsx?t=2:12:7)",
          "    at react-stack-bottom-frame (http://localhost:5173/node_modules/.vite/deps/react-dom.js:1:1)",
        ].join("\n"),
      },
    },
  });

  const context = getElementContext($("span:last-child"));

  expect(context.source).toEqual({
    functionName: null,
    fileName: "http://localhost:5173/src/List.tsx",
    lineNumber: 12,
    columnNumber: 7,
  });
  expect(context.selector).toBe("span:nth-of-type(2)");
});

it("anchors selectors on unique ids and semantic attributes", () => {
  const $ = mount(
    `<div id="app"><ul><li>a</li><li><a data-testid="go">go</a></li><li><i></i></li></ul></div>` +
      `<ul><li></li><li></li><li><i></i></li></ul>`,
  );
  expect(getElementContext($("a")).selector).toBe('a[data-testid="go"]');
  expect(getElementContext($("#app i")).selector).toBe("#app > ul > li:nth-of-type(3) > i");
  expect(getElementContext($("#app i")).componentName).toBeNull();
});
