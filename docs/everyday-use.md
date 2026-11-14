# Get the most out of Clanky: Mac to iPhone

Run Clanky on your computer and follow your projects from the Mac app, a browser
or your iPhone. Tailscale lets you take that same workspace with you, and Quick
Chat makes starting a new conversation a single click.

Start with a project folder and an agent you already use, installed and signed
in on your computer. Choose GitHub Copilot, Codex or OpenCode 2;
the [agent setup guide](harnesses.md#workspace-configuration) has instructions
for each.

## 1. Start Clanky

### With the Mac app

Download the Mac app from the
[latest release](https://github.com/pablozaiden/clanky/releases/latest),
unzip it, move `Clanky.app` to Applications and open it.

1. Create your account through **Local Controller > Initialize Owner
   Password...**. Choose a username and a password of at least 12 characters.
2. Choose **Local Controller > Start Local Controller**.
3. Follow the sign-in page that opens in your browser, sign in with your
   password and approve the connection. Return to Clanky.

The app remembers this setup and starts your controller the next time you open
Clanky. Keep the app running while you use it from another device.

### From Terminal

Install Clanky:

```bash
curl -fsSL https://raw.githubusercontent.com/pablozaiden/installer/main/install.sh \
  | sh -s -- pablozaiden/clanky
export PATH="$HOME/.local/bin:$PATH"
```

Then start it:

```bash
clanky serve
```

Open <http://localhost:3000> and follow **Create owner user**. Add a password
under **Settings > Account & access > Security > Password** to sign in from
your other devices.

## 2. Create your first workspace and chat

A workspace brings together your project and its conversations.

1. Open **Workspaces** and create a workspace with **Manual** setup.
2. Give it a name and enter your project folder in **Directory**. Enable **Git
   repository** for a Git project.
3. Choose your computer as the **Execution host** and select **GitHub Copilot**,
   **Codex** or **OpenCode 2** under **Adapter**. Test the connection and create
   the workspace.

Open **New Chat** from the workspace's menu and choose a model. Use worktrees
to give independent coding tasks their own working copy.

For larger changes, select **Start with a plan** and describe the result you
want. For example:

```text
Review the sign-in flow and propose a simpler experience for new users.
Show me the plan so we can discuss it before implementation.
```

Read **Plan** and **Status**, discuss the proposal, then send "Implement this
plan" when you're happy with it. Use **Diff** to review the changes.

## 3. Connect through Tailscale

Install [Tailscale](https://tailscale.com/download) on your computer and iPhone,
and sign in to the same Tailscale network on both.

### From the Mac app

1. Choose **Local Controller > Network Access...**.
2. Select **Automatic Remote Access (Tailscale)** and **Apply and Restart**.
3. Follow **Finish Tailscale Setup...** if it appears.
4. When you see **Available via Tailscale**, choose **Copy Remote Link**.

### From a manual controller

Follow the [manual Tailscale setup](deployment.md#tailscale-serve) to get your
remote HTTPS address. Keep Clanky and Tailscale Serve running.

Keep your computer awake and connected to Tailscale while working remotely.

## 4. Open Clanky in a browser or on iPhone

In a **browser**, open the
[Clanky browser client](https://pablozaiden.github.io/clanky/stable/api/)
and enter your remote link. This also works in Safari on your iPhone.

In the **iPhone app**, choose **Connect to an API** and paste the same link.

Follow the sign-in page, use your account password, check the displayed code
and approve the connection. Your workspaces and conversations are ready to use.

Try starting a chat on your Mac and continuing it from your phone. Keep the
iPhone app open during voice calls and file transfers.

## 5. Make Quick Chat a one-click habit

In the in-app **Settings > Chats > Quick Chat**:

1. Select the **Workspace** you use most.
2. Choose its **Model**.
3. Enable **Use worktrees for quick chats** if you want each quick task to have
   its own working copy.

Your choices save as you go. Use **Start Quick Chat** in the sidebar whenever
you want a fresh conversation with those settings, on Mac or iPhone.
When changing the Quick Chat workspace, choose its model again.

## 6. Choose text models and add voice

Choose a text model from your workspace's agent when creating a chat. Change it
under **Model** in the composer options between responses. A faster model is
handy for small requests; a more capable one is useful for planning and reviewing
larger changes.

To add voice, open **Settings > Voice**, enter your provider URL and API key,
and fill in the model names for the features you want:

| Setting | Use it for |
| --- | --- |
| **Transcription** | Dictate a message with **Talk** |
| **Text generation** | Listen to summaries, translate responses and support Live Voice |
| **Live Voice** | Talk to Clanky about your workspaces and chats |

Choose **Save**, then **Validate** beside each model you configured. The
[Voice setup guide](voice.md#provider-settings) has provider-specific help.

Use **Talk** from the composer options when you're ready to dictate a new
message. Stop the recording to transcribe and send it.

Start **Live Voice** from the sidebar microphone beside Quick Chat. Try
"Which chats need my input?" or "Open my project workspace." Review and approve
actions when Clanky asks. Allow microphone access when your device prompts you.

Under **Live Voice > Personal instructions**, set your preferred language and
style, for example: "Speak Spanish and keep answers short."

## Useful habits

Pin your favorite workspaces and chats, and give conversations recognizable
names. Home's **Needs attention** brings questions and approvals together.

Save recurring prompts in **Settings > Content > Templates**, and keep project
notes in [Scratchpad](scratchpad.md). Use **Code Explorer** to browse files and
attach screenshots or documents to give your agent useful context.

Use **Activity** to follow background work and **Diff** to review results.
Set up **Automations** for recurring tasks. If you use
[Listen](control-chats.md#agent-notifications), choose the alerts you want under
**Settings > Agents & integrations > Notifications**.
