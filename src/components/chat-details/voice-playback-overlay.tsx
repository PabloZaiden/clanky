import { Modal } from "@pablozaiden/webapp/web";
import type { VoicePlaybackRecovery } from "../../hooks";
import { Button } from "../common";

export function VoicePlaybackOverlay({
  recovery,
  onPlay,
  onCancel,
}: {
  recovery: VoicePlaybackRecovery | null;
  onPlay: () => Promise<void>;
  onCancel: () => void;
}) {
  if (!recovery) {
    return null;
  }

  const title = recovery.mode === "summary" ? "Summary audio ready" : "Audio ready";

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={title}
      showCloseButton={false}
      closeOnOverlayClick={false}
      size="sm"
      className="w-full max-w-md"
      footer={(
        <>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            aria-label="Play audio"
            onClick={() => void onPlay()}
          >
            Play audio
          </Button>
        </>
      )}
    >
      <div className="flex flex-col items-center gap-6 text-center">
        <div
          className="flex h-28 w-28 items-center justify-center rounded-full bg-blue-100 text-4xl text-blue-700 shadow-inner dark:bg-blue-950/60 dark:text-blue-300"
          aria-hidden="true"
        >
          <span>▶</span>
        </div>
        <p role="alert" className="text-sm text-gray-600 dark:text-gray-300">
          {recovery.message}
        </p>
      </div>
    </Modal>
  );
}
