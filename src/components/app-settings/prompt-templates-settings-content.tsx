import { useEffect, useState, type FormEvent } from "react";
import {
  Button,
  ConfirmModal,
  DataList,
  DataListRow,
  EmptyState,
  FormActions,
  LoadingState,
  Modal,
  TextAreaField,
  TextField,
} from "@pablozaiden/webapp/web";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, EditIcon } from "../common/Icons";
import {
  PROMPT_TEMPLATE_LIMITS,
  type PromptTemplate,
} from "@/shared/prompt-templates";
import { usePromptTemplates } from "../../hooks";
import { SettingsError } from "./settings-row-controls";

function createTemplateDraft(): PromptTemplate {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    prompt: "",
  };
}

export function PromptTemplatesSettingsContent() {
  const [draft, setDraft] = useState<PromptTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PromptTemplate | null>(null);
  const promptTemplates = usePromptTemplates();
  const {
    templates,
    loading,
    loaded,
    saving,
    loadError,
    saveError,
    clearSaveError,
    refresh,
    updateTemplates,
  } = promptTemplates;
  const templatesReady = loaded && !loading && !loadError;

  useEffect(() => {
    if (loadError) {
      setDeleteTarget(null);
    }
  }, [loadError]);

  async function saveTemplate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!draft || !templatesReady || saving) {
      return;
    }

    const normalizedDraft = {
      ...draft,
      name: draft.name.trim(),
      description: draft.description.trim(),
    };
    const existingIndex = templates.findIndex((template) => template.id === draft.id);
    const nextTemplates = [...templates];
    if (existingIndex === -1) {
      nextTemplates.push(normalizedDraft);
    } else {
      nextTemplates[existingIndex] = normalizedDraft;
    }
    if (await updateTemplates(nextTemplates)) {
      setDraft(null);
    }
  }

  async function moveTemplate(index: number, direction: -1 | 1): Promise<void> {
    if (!templatesReady || saving) {
      return;
    }

    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= templates.length) {
      return;
    }
    const nextTemplates = [...templates];
    [nextTemplates[index], nextTemplates[targetIndex]] = [
      nextTemplates[targetIndex]!,
      nextTemplates[index]!,
    ];
    await updateTemplates(nextTemplates);
  }

  async function deleteTemplate(): Promise<void> {
    if (!deleteTarget || !templatesReady || saving) {
      return;
    }
    const nextTemplates = templates.filter((template) => template.id !== deleteTarget.id);
    await updateTemplates(nextTemplates);
    setDeleteTarget(null);
  }

  function closeEditor(): void {
    if (saving) {
      return;
    }
    setDraft(null);
    clearSaveError();
  }

  const errorContent = (
    <>
      {loadError ? (
        <div className="flex flex-wrap items-center gap-2">
          <SettingsError>{loadError}</SettingsError>
          <Button
            type="button"
            size="sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {saveError ? <SettingsError>{saveError}</SettingsError> : null}
    </>
  );

  return (
    <div className="space-y-3">
      <FormActions>
        <Button
          type="button"
          variant="primary"
          disabled={!templatesReady || saving || templates.length >= PROMPT_TEMPLATE_LIMITS.count}
          onClick={() => setDraft(createTemplateDraft())}
        >
          New
        </Button>
      </FormActions>

      {!draft ? errorContent : null}
      {templates.length >= PROMPT_TEMPLATE_LIMITS.count ? (
        <SettingsError>
          Maximum of {PROMPT_TEMPLATE_LIMITS.count} templates.
        </SettingsError>
      ) : null}
      {loading && templates.length === 0 ? <LoadingState title="Loading templates" /> : null}
      {loaded && !loading && !loadError && templates.length === 0 ? (
        <EmptyState title="No templates" />
      ) : null}
      {templates.length > 0 ? (
        <DataList>
          {templates.map((template, index) => (
            <DataListRow
              key={template.id}
              className="max-sm:flex-col max-sm:!items-stretch"
              title={(
                <span className="max-sm:whitespace-normal max-sm:break-words">
                  {template.name}
                </span>
              )}
              description={template.description || undefined}
              actions={(
                <div className="flex flex-wrap justify-end gap-1 max-sm:w-full max-sm:max-w-none">
                  <Button
                    type="button"
                    size="sm"
                    aria-label={`Move ${template.name} up`}
                    disabled={!templatesReady || saving || index === 0}
                    onClick={() => void moveTemplate(index, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    aria-label={`Move ${template.name} down`}
                    disabled={!templatesReady || saving || index === templates.length - 1}
                    onClick={() => void moveTemplate(index, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    aria-label={`Edit ${template.name}`}
                    disabled={!templatesReady || saving}
                    onClick={() => setDraft({ ...template })}
                  >
                    <EditIcon />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    aria-label={`Delete ${template.name}`}
                    disabled={!templatesReady || saving}
                    onClick={() => setDeleteTarget(template)}
                  >
                    <CloseIcon />
                  </Button>
                </div>
              )}
            />
          ))}
        </DataList>
      ) : null}

      <Modal
        isOpen={draft !== null}
        onClose={closeEditor}
        title={templates.some((template) => template.id === draft?.id) ? "Edit template" : "New template"}
      >
        {draft ? (
          <form className="grid gap-4" onSubmit={(event) => void saveTemplate(event)}>
            {errorContent}
            <TextField
              label="Name"
              required
              maxLength={PROMPT_TEMPLATE_LIMITS.nameLength}
              value={draft.name}
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
            />
            <TextField
              label="Description"
              maxLength={PROMPT_TEMPLATE_LIMITS.descriptionLength}
              value={draft.description}
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })}
            />
            <TextAreaField
              label="Message"
              required
              rows={10}
              maxLength={PROMPT_TEMPLATE_LIMITS.promptLength}
              value={draft.prompt}
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })}
            />
            <FormActions>
              <Button type="button" disabled={saving} onClick={closeEditor}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                disabled={!templatesReady || saving || !draft.name.trim() || !draft.prompt.trim()}
              >
                Save template
              </Button>
            </FormActions>
          </form>
        ) : null}
      </Modal>

      <ConfirmModal
        isOpen={deleteTarget !== null && !loadError}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void deleteTemplate()}
        title="Delete template?"
        message={`Delete "${deleteTarget?.name ?? "template"}"? This cannot be undone.`}
        confirmLabel="Delete template"
        loading={saving || loading || !templatesReady}
        variant="danger"
      />
    </div>
  );
}
