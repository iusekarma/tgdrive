import { Check, Copy } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { api } from "../api";
import { DRIVE_NAME, PASSWORD_MIN } from "../format";
import { Button, Dialog, DialogActions, ErrorNote, Field, useSubmit } from "./ui";

export function checkNewPassword(password: string, repeat: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters for the password.`;
  if (password !== repeat) return "The two passwords don't match.";
  return null;
}

/** "New password" and "Repeat" fields. */
export function NewPasswordFields({
  label = "Password",
  hint,
  password,
  repeat,
  onPassword,
  onRepeat,
  autoFocus = false,
}: {
  label?: string;
  hint?: string;
  password: string;
  repeat: string;
  onPassword: (v: string) => void;
  onRepeat: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <>
      <Field
        label={label}
        type="password"
        autoComplete="new-password"
        autoFocus={autoFocus}
        required
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        hint={hint}
      />
      <Field
        label={`Repeat ${label.toLowerCase()}`}
        type="password"
        autoComplete="new-password"
        required
        value={repeat}
        onChange={(e) => onRepeat(e.target.value)}
      />
    </>
  );
}

export function UnlockDialog({
  drive,
  onClose,
  onUnlocked,
}: {
  drive: string;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const { busy, error, setError, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "password") {
      void run(async () => {
        await api.unlock(drive, password);
        onUnlocked();
      });
      return;
    }
    const problem = checkNewPassword(newPassword, repeat);
    if (problem) return setError(problem);
    void run(async () => {
      await api.recover(drive, recoveryKey.trim(), newPassword);
      onUnlocked();
    });
  }

  return (
    <Dialog title={mode === "password" ? `Unlock ${drive}` : `Reset the password for ${drive}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {mode === "password" ? (
          <Field
            label="Drive password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        ) : (
          <>
            <Field
              label="Recovery key"
              autoComplete="off"
              autoFocus
              required
              spellCheck={false}
              value={recoveryKey}
              onChange={(e) => setRecoveryKey(e.target.value)}
              hint="The key shown when this drive got its password."
            />
            <NewPasswordFields
              label="New password"
              password={newPassword}
              repeat={repeat}
              onPassword={setNewPassword}
              onRepeat={setRepeat}
            />
          </>
        )}
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <button
            type="button"
            className="mr-auto text-sm text-teal underline underline-offset-2"
            onClick={() => {
              setError(null);
              setMode(mode === "password" ? "recovery" : "password");
            }}
          >
            {mode === "password" ? "Forgot the password?" : "Use the password instead"}
          </button>
          <Button variant="primary" type="submit" disabled={busy}>
            {mode === "password" ? (busy ? "Unlocking…" : "Unlock") : busy ? "Resetting…" : "Reset password"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function CreateDriveDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string, recoveryKey: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const { busy, error, setError, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!DRIVE_NAME.test(trimmed) || trimmed.length > 64) {
      return setError("Drive names start with a letter or number and use only letters, numbers, spaces, . _ and -");
    }
    if (protect) {
      const problem = checkNewPassword(password, repeat);
      if (problem) return setError(problem);
    }
    void run(async () => {
      const created = await api.createDrive(trimmed, protect ? password : null);
      onCreated(created.name, created.recovery_key);
    });
  }

  return (
    <Dialog title="Create a drive" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" autoFocus required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={protect}
            onChange={(e) => setProtect(e.target.checked)}
          />
          <span>
            <span className="font-medium">Protect with its own password</span>
            <span className="block text-muted">
              {protect
                ? "Opening this drive will need the master password and this one."
                : "Without one, the drive opens as soon as the master password is entered."}
            </span>
          </span>
        </label>
        {protect && (
          <NewPasswordFields
            label="Drive password"
            password={password}
            repeat={repeat}
            onPassword={setPassword}
            onRepeat={setRepeat}
          />
        )}
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create drive"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Shows a recovery key exactly once. The only way out is to confirm it has been saved. */
export function RecoveryKeyDialog({
  title,
  recoveryKey,
  action,
  onDone,
  children,
}: {
  title: string;
  recoveryKey: string;
  action: string;
  onDone: () => void;
  children: ReactNode;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog title={title} onClose={() => saved && onDone()}>
      <p className="text-sm text-muted">{children} It is shown once and is not stored anywhere.</p>
      <div className="mt-4 rounded-md border border-brass/50 bg-brass/10 p-4">
        <p className="select-all break-words text-lg font-medium leading-relaxed tracking-wide">{recoveryKey}</p>
      </div>
      <Button onClick={copy} className="mt-3">
        {copied ? <Check size={16} /> : <Copy size={16} />}
        {copied ? "Copied" : "Copy key"}
      </Button>
      <label className="mt-5 flex items-start gap-2.5 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I have saved this key somewhere safe.
      </label>
      <DialogActions>
        <Button variant="primary" disabled={!saved} onClick={onDone}>
          {action}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export type PasswordAction = "add" | "change" | "remove";

const PASSWORD_TITLES: Record<PasswordAction, string> = {
  add: "Add a password to",
  change: "Change the password for",
  remove: "Remove the password from",
};

/** Only the drive key is re-wrapped, so this is instant whatever the drive holds. */
export function DrivePasswordDialog({
  drive,
  action,
  onClose,
  onDone,
}: {
  drive: string;
  action: PasswordAction;
  onClose: () => void;
  onDone: (recoveryKey: string | null) => void;
}) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const { busy, error, setError, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (action !== "remove") {
      const problem = checkNewPassword(password, repeat);
      if (problem) return setError(problem);
    }
    void run(async () => {
      const result = await api.setDrivePassword(
        drive,
        action === "add" ? null : current,
        action === "remove" ? null : password,
      );
      onDone(result.recovery_key);
    });
  }

  return (
    <Dialog title={`${PASSWORD_TITLES[action]} ${drive}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {action === "add" && (
          <p className="text-sm text-muted">
            Opening {drive} will then need the master password and this one. You'll get a recovery key for it.
          </p>
        )}
        {action === "remove" && (
          <p className="text-sm text-muted">
            {drive} will open with the master password alone, and its recovery key will stop working.
          </p>
        )}
        {action !== "add" && (
          <Field
            label="Current drive password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        )}
        {action !== "remove" && (
          <NewPasswordFields
            label="New password"
            autoFocus={action === "add"}
            password={password}
            repeat={repeat}
            onPassword={setPassword}
            onRepeat={setRepeat}
          />
        )}
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={action === "remove" ? "danger" : "primary"} type="submit" disabled={busy}>
            {busy ? "Saving…" : action === "remove" ? "Remove password" : "Save password"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function MasterPasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, setError, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    const problem = checkNewPassword(password, repeat);
    if (problem) return setError(problem);
    void run(async () => {
      await api.changeVaultPassword(current, password);
      setDone(true);
    });
  }

  if (done) {
    return (
      <Dialog title="Master password changed" onClose={onClose}>
        <p className="text-sm text-muted">
          Use the new password next time. Your master recovery key still works, and no drive was changed.
        </p>
        <DialogActions>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Dialog title="Change the master password" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Current master password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <NewPasswordFields
          label="New password"
          password={password}
          repeat={repeat}
          onPassword={setPassword}
          onRepeat={setRepeat}
        />
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Changing…" : "Change password"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function DeleteDriveDialog({
  drive,
  isProtected,
  onClose,
  onDeleted,
}: {
  drive: string;
  isProtected: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api.deleteDrive(drive, password);
      onDeleted();
    });
  }

  return (
    <Dialog title={`Delete ${drive}?`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">
          This deletes the drive and every file in it, including the copies in your Telegram channel. It can't be
          undone.
        </p>
        <Field
          label={isProtected ? "Drive password" : "Master password"}
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorNote>{error}</ErrorNote>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" type="submit" disabled={busy}>
            {busy ? "Deleting…" : "Delete drive"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
