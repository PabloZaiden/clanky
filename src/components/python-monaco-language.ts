/**
 * Monaco Python tokenizer customization for the code explorer.
 */

import type { BeforeMount, Monaco } from "@monaco-editor/react";
import type { languages } from "monaco-editor";

export const CLANKY_PYTHON_LANGUAGE_ID = "clanky-python";

interface MonacoPythonLanguageModule {
  conf: languages.LanguageConfiguration;
  language: languages.IMonarchLanguage;
}

interface MonacoPythonLanguageEntry {
  id: string;
  loader: () => Promise<MonacoPythonLanguageModule>;
}

function createTripleQuotedFStringRules(
  quote: '"' | "'",
): languages.IMonarchLanguageRule[] {
  if (quote === '"') {
    return [
      [/"""/, "string.escape", "@pop"],
      [/\{\{|\}\}/, "string"],
      [/[^\\\"\{\}]+/, "string"],
      [/\{[^\}':!=]+/, "identifier", "@fStringDetail"],
      [/\\./, "string"],
      [/"/, "string"],
      [/\\$/, "string"],
    ];
  }

  return [
    [/'''/, "string.escape", "@pop"],
    [/\{\{|\}\}/, "string"],
    [/[^\\'\{\}]+/, "string"],
    [/\{[^\}':!=]+/, "identifier", "@fStringDetail"],
    [/\\./, "string"],
    [/'/, "string"],
    [/\\$/, "string"],
  ];
}

function createPatchedPythonLanguage(
  baseLanguage: languages.IMonarchLanguage,
): languages.IMonarchLanguage {
  const baseStringRules = baseLanguage.tokenizer["strings"];
  if (!baseStringRules) {
    throw new Error("Monaco Python tokenizer does not define string rules");
  }

  return {
    ...baseLanguage,
    tokenizer: {
      ...baseLanguage.tokenizer,
      strings: [
        [/[fF][rR]?"""/, "string.escape", "@fTripleDblStringBody"],
        [/[rR][fF]"""/, "string.escape", "@fTripleDblStringBody"],
        [/[fF][rR]?'''/, "string.escape", "@fTripleStringBody"],
        [/[rR][fF]'''/, "string.escape", "@fTripleStringBody"],
        ...baseStringRules,
      ],
      fTripleDblStringBody: createTripleQuotedFStringRules('"'),
      fTripleStringBody: createTripleQuotedFStringRules("'"),
    },
  };
}

async function registerClankyPythonLanguage(monaco: Monaco): Promise<void> {
  const pythonEntry = monaco.languages
    .getLanguages()
    .find((language: { id: string }) => language.id === "python") as MonacoPythonLanguageEntry | undefined;
  if (!pythonEntry || typeof pythonEntry.loader !== "function") {
    throw new Error("Monaco Python language loader is unavailable");
  }

  const pythonModule = await pythonEntry.loader();
  monaco.languages.setLanguageConfiguration(CLANKY_PYTHON_LANGUAGE_ID, pythonModule.conf);
  monaco.languages.setMonarchTokensProvider(
    CLANKY_PYTHON_LANGUAGE_ID,
    createPatchedPythonLanguage(pythonModule.language),
  );
}

let configuredMonaco: Monaco | null = null;
let configurationPromise: Promise<void> | null = null;

export const configureClankyPython: BeforeMount = (monaco) => {
  if (configuredMonaco !== monaco) {
    monaco.languages.register({
      id: CLANKY_PYTHON_LANGUAGE_ID,
      aliases: ["Python"],
    });
    configuredMonaco = monaco;
    configurationPromise = null;
  }

  if (configurationPromise) {
    return;
  }

  const promise = registerClankyPythonLanguage(monaco);
  configurationPromise = promise;
  void promise.catch((error: unknown) => {
    if (configuredMonaco === monaco && configurationPromise === promise) {
      configurationPromise = null;
    }
    console.error("Failed to configure multiline Python strings in Monaco:", error);
  });
};
