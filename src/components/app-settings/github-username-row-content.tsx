import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsError, SettingsInput } from "./settings-row-controls";

export function GithubUsernameRowContent({
  githubUsername,
  loading,
  saving,
  error,
  onUpdate,
}: {
  githubUsername: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onUpdate: (githubUsername: string) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(githubUsername);
  const draftRef = useRef(draft);
  const lastSavedValueRef = useRef(githubUsername);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (githubUsername === lastSavedValueRef.current) {
      return;
    }
    setDraft(githubUsername);
    draftRef.current = githubUsername;
    lastSavedValueRef.current = githubUsername;
  }, [githubUsername]);

  const saveDraft = useCallback(async (): Promise<void> => {
    const normalized = draftRef.current.trim();
    if (normalized === lastSavedValueRef.current) {
      if (draftRef.current !== normalized) {
        setDraft(normalized);
        draftRef.current = normalized;
      }
      return;
    }
    const saved = await onUpdate(normalized);
    if (saved !== null) {
      setDraft(saved);
      draftRef.current = saved;
      lastSavedValueRef.current = saved;
    }
  }, [onUpdate]);

  return (
    <div className="space-y-2">
      <SettingsInput
        id="github-username"
        aria-label="GitHub username"
        value={draft}
        placeholder="octocat"
        autoComplete="username"
        disabled={loading || saving}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          setDraft(nextValue);
          draftRef.current = nextValue;
        }}
        onBlur={() => void saveDraft()}
        onKeyDown={(event) => {
          if (event.key !== "Enter") {
            return;
          }
          event.preventDefault();
          void saveDraft();
        }}
      />
      {saving ? <p className="text-xs text-gray-500 dark:text-gray-400">Saving...</p> : null}
      {error ? <SettingsError>{error}</SettingsError> : null}
    </div>
  );
}
