import sanitizeHtml from "sanitize-html";
import { maxHtmlChars } from "../drafts/html-text.ts";

/** Formatting and layout only: no scripts, forms, frames, embeds, `<style>`, `<base>` or `<meta>`. */
const allowedTags = [...sanitizeHtml.defaults.allowedTags, "img", "center", "font", "del", "ins"];

/** Raster images inlined in the email itself. SVG is left out: it is a document, not a picture. */
const inlineImage = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/**
 * Inline styles may lay text out, never fetch or hide anything: `url(` would load a remote
 * resource (a tracking pixel), and escapes or comments could smuggle one past this check.
 */
const unsafeStyle = /url\s*\(|image-set|@import|expression|javascript:|\\|\/\*/i;

function withSafeStyle(attribs: sanitizeHtml.Attributes): sanitizeHtml.Attributes {
  const { style, ...rest } = attribs;
  return style && !unsafeStyle.test(style) ? { ...rest, style } : rest;
}

const tableCell = ["colspan", "rowspan", "align", "valign", "width", "height", "bgcolor"];

/**
 * Untrusted email HTML made safe to render (ADR 0004): an allow-list of tags and attributes,
 * links limited to http, https and mailto and opened in a new tab without a referrer, and
 * remote images replaced by their alt text, so opening an email never tells the sender.
 * The dashboard also renders the result in a sandboxed iframe under a strict CSP; this is the
 * first of those layers, and the one agents reading the API rely on.
 */
export function sanitizeEmailHtml(html: string): string {
  const safe = sanitizeHtml(html.slice(0, maxHtmlChars), {
    allowedTags,
    allowedAttributes: {
      "*": ["style", "dir", "lang", "title", "align"],
      // The transform below sets these two itself; whatever the email had is overwritten.
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      font: ["color", "size", "face"],
      table: ["width", "border", "cellpadding", "cellspacing", "bgcolor", "align"],
      td: tableCell,
      th: tableCell,
      col: ["span", "width"],
      colgroup: ["span", "width"],
      ol: ["start", "type"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    // Only what is inside <body>: nothing from <head> survives.
    enforceHtmlBoundary: true,
    disallowedTagsMode: "discard",
    // Dropped with their text, not just their tags: none of these is something to read.
    nonTextTags: [
      "script",
      "style",
      "textarea",
      "option",
      "noscript",
      "title",
      "head",
      "template",
      "xmp",
      "noembed",
      "noframes",
      "iframe",
      "object",
    ],
    // sanitize-html runs one transform per tag (a tag's own replaces "*"), so each one
    // filters the style too.
    transformTags: {
      "*": (tagName, attribs) => ({ tagName, attribs: withSafeStyle(attribs) }),
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...withSafeStyle(attribs),
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      }),
      img: (_tagName, attribs) => {
        if (attribs.src && inlineImage.test(attribs.src)) {
          return { tagName: "img", attribs: withSafeStyle(attribs) };
        }
        return {
          tagName: "span",
          attribs: {},
          text: `[image${attribs.alt ? `: ${attribs.alt}` : ""}]`,
        };
      },
    },
  });
  return safe.trim();
}
