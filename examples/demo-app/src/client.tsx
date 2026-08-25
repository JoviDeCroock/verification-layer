import { signal, useSignal } from "@preact/signals";
import { render } from "preact";
import { useEffect } from "preact/hooks";

interface Invitation {
  id: string;
  email: string;
  expired: boolean;
}

const invitations = signal<Invitation[]>([]);
const role = signal<"admin" | "member">("admin");
const email = signal("new-member@example.com");
const message = signal("");
const busy = signal(false);

async function refreshInvitations(): Promise<void> {
  const response = await fetch("/api/invitations");
  const data = (await response.json()) as { invitations: Invitation[] };
  invitations.value = data.invitations;
}

function InvitePage() {
  useEffect(() => {
    void refreshInvitations();
  }, []);
  const submit = async (event: Event) => {
    event.preventDefault();
    busy.value = true;
    const response = await fetch("/api/invitations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-role": role.value },
      body: JSON.stringify({ email: email.value }),
    });
    const data = (await response.json()) as { error?: string; duplicate?: boolean };
    message.value = response.ok
      ? data.duplicate
        ? "Invitation already pending."
        : "Invitation sent."
      : (data.error ?? "Invitation failed.");
    await refreshInvitations();
    busy.value = false;
  };
  return (
    <main>
      <p class="eyebrow">Executable Trust Demo</p>
      <h1>Team invitations</h1>
      <p class="lede">A deliberately small product surface for intent-driven verification.</p>
      <form onSubmit={submit}>
        <label>
          Email{" "}
          <input
            data-testid="invite-email"
            value={email.value}
            onInput={(event) => (email.value = event.currentTarget.value)}
          />
        </label>
        <label>
          Acting as{" "}
          <select
            data-testid="role"
            value={role.value}
            onChange={(event) => (role.value = event.currentTarget.value as "admin" | "member")}
          >
            <option value="admin">Administrator</option>
            <option value="member">Member</option>
          </select>
        </label>
        <button data-testid="send-invite" disabled={busy.value}>
          Send invitation
        </button>
      </form>
      <p data-testid="message" class="message">
        {message.value}
      </p>
      <section aria-labelledby="pending-heading">
        <h2 id="pending-heading">Pending invitations</h2>
        <ul data-testid="invitation-list">
          {invitations.value.map((item) => (
            <li data-testid="invitation" key={item.id}>
              <span>{item.email}</span>
              <small>{item.expired ? "Expired" : "Pending"}</small>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function SignupPage() {
  return (
    <main>
      <p class="eyebrow">Existing flow</p>
      <h1>Sign up</h1>
      <label>
        Email <input data-testid="signup-email" type="email" />
      </label>
      <button>Create account</button>
    </main>
  );
}

function AcceptancePage({ id }: { id: string }) {
  const state = useSignal("Checking invitation…");
  useEffect(() => {
    void fetch(`/api/invitations/${id}`).then(async (response) => {
      const data = (await response.json()) as { error?: string };
      state.value = response.ok
        ? "Invitation ready to accept."
        : (data.error ?? "Invitation unavailable.");
    });
  }, [id]);
  return (
    <main>
      <p class="eyebrow">Invitation</p>
      <h1 data-testid="acceptance-state">{state.value}</h1>
    </main>
  );
}

function App() {
  if (location.pathname === "/signup") return <SignupPage />;
  if (location.pathname.startsWith("/accept/"))
    return <AcceptancePage id={location.pathname.split("/").at(-1) ?? ""} />;
  return <InvitePage />;
}

render(<App />, document.getElementById("app")!);
