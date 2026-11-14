import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

let client = null;
let activeWorkspace = null;
let activeMembership = null;

function showGate() { document.getElementById("authGate").hidden = false; }
function hideGate() { document.getElementById("authGate").hidden = true; }
function message(text, error = false) {
  const el = document.getElementById("authMessage");
  el.textContent = text;
  el.classList.toggle("error", error);
}

async function initClient() {
  if (!SUPABASE_URL || SUPABASE_URL.includes("PASTE_YOUR_") || !SUPABASE_PUBLISHABLE_KEY || SUPABASE_PUBLISHABLE_KEY.includes("PASTE_YOUR_")) {
    throw new Error("WIWY has not been configured yet. Add the Supabase Project URL and Publishable key to js/config.js in your GitHub repository.");
  }
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  return client;
}

async function ensureWorkspace(user) {
  const invitationToken = new URLSearchParams(location.search).get("invite");
  let invitedWorkspaceId = null;
  if (invitationToken) {
    const { data: acceptedInvitation, error: acceptError } = await client.rpc("wiwy_accept_member_invitation", {
      invitation_token: invitationToken
    });
    if (acceptError) throw acceptError;
    if (!acceptedInvitation?.workspace_id) throw new Error("The invitation response did not identify a household.");
    invitedWorkspaceId = acceptedInvitation.workspace_id;
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete("invite");
    history.replaceState({}, "", cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
  }

  const { data: memberships, error } = await client
    .from("workspace_memberships")
    .select("id, workspace_id, role, member_profile_id, workspaces(id,name,timezone)")
    .eq("user_id", user.id);
  if (error) throw error;

  const invitedMembership = invitationToken
    ? (memberships || []).find(item => item.workspace_id === invitedWorkspaceId)
    : null;
  if (invitationToken && !invitedMembership) throw new Error("The invitation was accepted, but its household membership could not be loaded. Sign out and back in.");
  if (invitedMembership || memberships?.length) {
    activeMembership = invitedMembership || memberships[0];
    activeWorkspace = activeMembership.workspaces;
    if (!activeWorkspace) {
      const { data: ws, error: wsError } = await client.from("workspaces").select("id,name,timezone").eq("id", activeMembership.workspace_id).single();
      if (wsError) throw wsError;
      activeWorkspace = ws;
    }
    return;
  }

  if (invitationToken) throw new Error("The invitation was accepted, but WIWY could not load the household membership. Sign out and back in.");
  const name = prompt("What would you like to call your household workspace?", "Our Home");
  if (name === null) throw new Error("Workspace setup was cancelled. Sign in again when you're ready.");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
  const { data: workspaceId, error: createError } = await client.rpc("create_workspace_with_owner", {
    workspace_name: name.trim() || "Our Home",
    workspace_timezone: timezone
  });
  if (createError) throw createError;

  const { data: profile, error: profileError } = await client.from("member_profiles").insert({
    workspace_id: workspaceId,
    display_name: user.user_metadata?.full_name || user.email?.split("@")[0] || "Admin",
    color: "#3f6048"
  }).select("id").single();
  if (profileError) throw profileError;

  const { data: membership, error: membershipError } = await client.from("workspace_memberships")
    .update({ member_profile_id: profile.id })
    .eq("workspace_id", workspaceId).eq("user_id", user.id)
    .select("id,workspace_id,role,member_profile_id").single();
  if (membershipError) throw membershipError;

  const { data: workspace, error: readError } = await client.from("workspaces")
    .select("id,name,timezone").eq("id", workspaceId).single();
  if (readError) throw readError;
  activeMembership = membership;
  activeWorkspace = workspace;
}

export async function requireAuth() {
  showGate();
  const signInButton = document.getElementById("authSignIn");
  const signUpButton = document.getElementById("authSignUp");
  try {
    await initClient();
    const { data: { session }, error } = await client.auth.getSession();
    if (error) throw error;
    if (session) {
      await ensureWorkspace(session.user);
      hideGate();
      return { client, workspace: activeWorkspace, membership: activeMembership };
    }
  } catch (error) {
    message(error.message || "Could not connect to WIWY.", true);
    throw error;
  }

  return await new Promise((resolve) => {
    const connect = async (mode) => {
      const email = document.getElementById("authEmail").value.trim();
      const password = document.getElementById("authPassword").value;
      const displayName = document.getElementById("authName").value.trim();
      if (!email || !password) { message("Enter your email address and password.", true); return; }
      try {
        message(mode === "signup" ? "Creating your account…" : "Signing in…");
        let result;
        if (mode === "signup") {
          result = await client.auth.signUp({
            email, password,
            options: {
  data: { full_name: displayName || email.split("@")[0] },
  emailRedirectTo: "https://crookedwindmilleng.github.io/household_management/"
}
          });
          if (result.error) throw result.error;
          if (!result.data.session) {
            message("Account created. Check your email for the confirmation link. After confirming, return here and sign in.");
            return;
          }
        } else {
          result = await client.auth.signInWithPassword({ email, password });
          if (result.error) throw result.error;
        }
        const user = result.data.user || result.data.session?.user;
        if (!user) throw new Error("Supabase did not return an authenticated user.");
        await ensureWorkspace(user);
        hideGate();
        resolve({ client, workspace: activeWorkspace, membership: activeMembership });
      } catch (error) {
        message(error.message || "Something went wrong.", true);
      }
    };
    signInButton.onclick = () => connect("signin");
    signUpButton.onclick = () => connect("signup");
  });
}

export function getSupabase() { return client; }
export function getActiveWorkspace() { return activeWorkspace; }
export function getActiveMembership() { return activeMembership; }
export function getActiveUser() { return client?.auth?.getUser ? null : null; }
export async function renameActiveWorkspace(name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("Workspace name is required.");
  if (!client || !activeWorkspace?.id) throw new Error("No active workspace is available.");
  const { data, error } = await client.from("workspaces")
    .update({ name: cleanName })
    .eq("id", activeWorkspace.id)
    .select("id,name,timezone")
    .single();
  if (error) throw error;
  activeWorkspace = data;
  return data;
}
export async function getSignedInUser() {
  if (!client) return null;
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  return data.user;
}
