import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";

import { api, ApiError } from "../api";
import { forgetThumbnails } from "../thumbs";
import { checkNewPassword, NewPasswordFields, RecoveryKeyDialog } from "./driveDialogs";
import LockDial from "./LockDial";
import { Button, ErrorNote, Field, useSubmit } from "./ui";

function Screen({ title, intro, children }: { title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-16">
      <LockDial unlocked={false} />
      <h1 className="mt-6 text-4xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-muted">{intro}</p>
      <div className="mt-8">{children}</div>
    </main>
  );
}

function SetupScreen({ needsAdmin, onDone }: { needsAdmin: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const { busy, error, setError, run } = useSubmit();

  function submit(e: FormEvent) {
    e.preventDefault();
    const problem = checkNewPassword(password, repeat);
    if (problem) return setError(problem);
    void run(async () => {
      try {
        const result = await api.setupVault(password, adminPassword);
        setRecoveryKey(result.recovery_key);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) throw new Error("That admin password is not correct.");
        if (err instanceof ApiError && err.status === 409) {
          onDone(); // someone else finished setting up first
          return;
        }
        throw err;
      }
    });
  }

  return (
    <Screen
      title="Set up tgdrive"
      intro="Choose a master password. Nothing in tgdrive opens without it, and drives can add a second password of their own."
    >
      <form onSubmit={submit} className="space-y-4">
        <NewPasswordFields
          label="Master password"
          autoFocus
          password={password}
          repeat={repeat}
          onPassword={setPassword}
          onRepeat={setRepeat}
        />
        {needsAdmin && (
          <Field
            label="Admin password"
            type="password"
            autoComplete="off"
            required
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
            hint="Set on the server as TGDRIVE_ADMIN_PASSWORD."
          />
        )}
        <ErrorNote>{error}</ErrorNote>
        <Button variant="primary" type="submit" disabled={busy} className="w-full">
          {busy ? "Setting up…" : "Set master password"}
        </Button>
      </form>
      {recoveryKey && (
        <RecoveryKeyDialog title="Save your master recovery key" recoveryKey={recoveryKey} action="Continue" onDone={onDone}>
          If you forget the master password, this key is the only way back in.
        </RecoveryKeyDialog>
      )}
    </Screen>
  );
}

function LoginScreen({ onUnlocked }: { onUnlocked: () => void }) {
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
        await api.unlockVault(password);
        onUnlocked();
      });
      return;
    }
    const problem = checkNewPassword(newPassword, repeat);
    if (problem) return setError(problem);
    void run(async () => {
      await api.recoverVault(recoveryKey.trim(), newPassword);
      onUnlocked();
    });
  }

  return (
    <Screen
      title={mode === "password" ? "tgdrive is locked" : "Reset the master password"}
      intro={
        mode === "password"
          ? "Enter the master password to see your drives."
          : "Use the master recovery key you saved when tgdrive was set up."
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {mode === "password" ? (
          <Field
            label="Master password"
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
              label="Master recovery key"
              autoComplete="off"
              autoFocus
              required
              spellCheck={false}
              value={recoveryKey}
              onChange={(e) => setRecoveryKey(e.target.value)}
            />
            <NewPasswordFields
              label="New master password"
              password={newPassword}
              repeat={repeat}
              onPassword={setNewPassword}
              onRepeat={setRepeat}
            />
          </>
        )}
        <ErrorNote>{error}</ErrorNote>
        <Button variant="primary" type="submit" disabled={busy} className="w-full">
          {mode === "password" ? (busy ? "Unlocking…" : "Unlock") : busy ? "Resetting…" : "Reset and unlock"}
        </Button>
        <button
          type="button"
          className="text-sm text-teal underline underline-offset-2"
          onClick={() => {
            setError(null);
            setMode(mode === "password" ? "recovery" : "password");
          }}
        >
          {mode === "password" ? "Forgot the master password?" : "Use the master password instead"}
        </button>
      </form>
    </Screen>
  );
}

/** Locks the vault and every drive, and drops everything decrypted from memory. */
export function useLockEverything() {
  const queryClient = useQueryClient();
  return async () => {
    await api.logout().catch(() => undefined);
    forgetThumbnails();
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "vault" });
    await queryClient.invalidateQueries({ queryKey: ["vault"] });
  };
}

/** Nothing below this renders until the master password has been entered. */
export default function VaultGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const vault = useQuery({ queryKey: ["vault"], queryFn: api.vault, staleTime: Infinity });

  const refresh = () => {
    // Anything fetched while locked is a stale "locked" answer.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "vault" });
    void queryClient.invalidateQueries({ queryKey: ["vault"] });
  };

  if (vault.isPending) return <p className="p-10 text-muted">Loading…</p>;
  if (vault.error) {
    return (
      <Screen title="tgdrive" intro="">
        <div className="space-y-4">
          <ErrorNote>{vault.error.message}</ErrorNote>
          <Button onClick={() => void vault.refetch()}>Try again</Button>
        </div>
      </Screen>
    );
  }
  if (!vault.data.initialized) return <SetupScreen needsAdmin={vault.data.setup_needs_admin} onDone={refresh} />;
  if (!vault.data.unlocked) return <LoginScreen onUnlocked={refresh} />;
  return <>{children}</>;
}
