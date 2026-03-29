import type { HighlighterCore } from "@shikijs/core";
import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import javascript from "@shikijs/langs/javascript";
import typescript from "@shikijs/langs/typescript";
import jsx from "@shikijs/langs/jsx";
import tsx from "@shikijs/langs/tsx";
import json from "@shikijs/langs/json";
import html from "@shikijs/langs/html";
import css from "@shikijs/langs/css";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import bash from "@shikijs/langs/bash";
import yaml from "@shikijs/langs/yaml";
import toml from "@shikijs/langs/toml";
import sql from "@shikijs/langs/sql";
import rust from "@shikijs/langs/rust";
import go from "@shikijs/langs/go";
import dockerfile from "@shikijs/langs/dockerfile";
import diff from "@shikijs/langs/diff";

let highlighterPromise: Promise<HighlighterCore> | null = null;

export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [githubDark, githubLight],
      langs: [
        javascript,
        typescript,
        jsx,
        tsx,
        json,
        html,
        css,
        markdown,
        python,
        bash,
        yaml,
        toml,
        sql,
        rust,
        go,
        dockerfile,
        diff,
      ],
    });
  }
  return highlighterPromise;
}
