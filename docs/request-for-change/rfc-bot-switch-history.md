---
title: Bot switch history -- switching Bots on a wide screen adds a Back step, as switching sessions does
status: draft
author: peterhieuvu
created: 2026-11-09
last-audited: 2026-11-09
audited-at: 4bbbc50200
doc-pr: null
implementation-prs: []
tracking-issues: [31418]
supersedes: []
superseded-by: []
---

# RFC: Bot switch history

- Status: draft. Nothing is built; this document changes no code. It asks a maintainer to accept or change the design.
- Tracks [#31418](https://github.com/kirodotdev/KiroCrew/issues/31418). bolichen97 answered there that the replace is deliberate, so a push is "a change to an existing experience rather than a bug", and pointed to this process. This document is that proposal.
- Main measured at `4bbbc50200`; the repro below ran at `e648fad6c3`, and no file it touches changed between the two. Paths are under `website/src/`.

## 1. Problem

On the Bots page, Back and Forward do not walk the Bots a person visited, but only when they switch with the controls on the page. The same switch made from the left rail does add a step. So the app gives two answers to one gesture.

Repro: a headless browser at 1400×900 on a fresh data home with three Bots (Alpha, Beta, Gamma), with every `pushState` and `replaceState` logged.

| Step | URL after | History write | `history.length` |
|---|---|---|---|
| `/chat`, then `/members?member=Alpha` | `?member=Alpha` | none | 3 |
| Header Bot switcher: Beta | `?member=Beta` | replace | 3 |
| Header Bot switcher: Gamma | `?member=Gamma` | replace | 3 |
| Back | `/chat/...` | none (Alpha and Beta skipped) | 3 |
| Left rail, starred Bot icons: Alpha, Beta, Gamma | `?member=Gamma` | push, push, push | 6 |
| Back, Back, Back | Beta, Alpha, `/chat/...` | none (each step retraced) | 6 |

The Dashboard, Workspace and profile-card Goals tabs wrote no history in either run.

## 2. Current behaviour

- `pages/members/useMembersPageNavigation.ts`, `openMember`: every in-page switch (the header switcher, the roster, a staged-dashboard link in a thread) writes `setSearchParams({ member }, { replace: true })` at every width. Its comment calls this "the Sessions sidebar's rule".
- `utils/sessionUrlHistory.ts`, `shouldReplaceSessionUrl`: the Sessions rule is in fact "desktop pushes on a real session switch, mobile always replaces". The chat page's URL sync in `pages/chat/useChatPageSessionController.ts` follows it.
- `shell/nav/matesDock.tsx`, `DockMatesSection` and `MateNavItem`: a wide-rail starred Bot is a `NavItem` to `/members?member=<name>`, which the router pushes. On the phone rail, `DockMatesTiles` passes `replace`.
- The URL-to-Bot sync effect in `useMembersPageNavigation` already opens whatever `?member=` a Back or Forward lands on, so the page handles a pushed entry today. The rail run in section 1 shows it.

## 3. Proposal

In `openMember`, replace the fixed `{ replace: true }` with the Sessions predicate, and let a caller force a replace with an explicit override:

```ts
setSearchParams({ [MEMBER_PARAM]: m.name }, {
  replace: opts?.replace ?? shouldReplaceSessionUrl({ isSessionSwitch: !!activeName, isMobile }),
})
```

`isSessionSwitch` is true when another Bot is already open. `openMember` returns early for the open Bot itself, so a re-click stays the repair gesture and writes nothing.

`openCreated` in `MembersPage.tsx` opens a newly created Bot through `openMember`, and `openCreate` leaves the open Bot set, so without the override creating Bot B while Bot A is open would push. `openCreated` therefore passes `replace: true`. A create is not a switch the person chose, which matches the other automatic opens. Every other caller passes no override.

The arrival auto-open, the Mate landing and a gone-name fallback write their own replaces in the URL-to-Bot sync and do not go through `openMember`, so they are unchanged. With the override, a create's first open keeps its replace too, because none of these is a switch the person made. The comment on `openMember` is corrected to state the rule it now shares.

## 4. Why

- **One rule for one gesture.** The rail already pushes this exact switch, and the Sessions page pushes the equivalent one on desktop. Under the proposal, Back means the same thing whichever control made the switch.
- **Platform expectations.** On desktop, Back and Forward are real controls: the browser buttons, the header arrows and ⌘/Ctrl+←/→ (`useGuardedHistoryStep` in `components/NavigationLeaveGuard.tsx`), and a mouse's side buttons in the macOS app (`useNativeHistoryStep` in `shell/platform/nativeHistoryStep.ts`, from #31539). The reporter on #31418 used the Mac app and expected each switch to be a step.
- **The stated reason does not hold on desktop.** The replace cites the Sessions rule, but the reason Sessions replaces on mobile (the left-edge swipe is the only back there, and drawers push nothing) has no desktop counterpart.

## 5. What stays the same

- **Phones and narrow windows.** `isMobile` keeps every switch a replace, so one Back still leaves the page, as `pages/members/MembersPage.narrow.test.tsx` pins. The drawer pick (`pickFromRosterDrawer`) is unchanged.
- **In-page tabs.** Dashboard, Workspace and the profile card's tabs stay component state and write no history, as the chat page's side-panel tabs do.
- **Deep links and the rail.** `/members?member=<name>` from a link, a notification or the rail still pushes as today. A bare `/members` still lands on the remembered Bot with a replace.
- **Teams.** `openTeam` in `useMembersPageTeams.ts` keeps its replace. Section 9 asks whether it should follow.

## 6. Risks

- **History growth.** Each desktop switch adds one entry, as each session switch does. Someone who visits ten Bots needs ten Backs to leave the page. The header arrows' history menu can jump straight to an entry.
- **Unsaved Schedules, Goals or export drafts on Back.** Read in the code: the URL-to-Bot sync path does **not** run the page's own leave check. The effect calls `activate` directly. `openMember`'s `schedAtStakeRef` / `schedGuardRef` check runs only for in-page clicks. The Schedules section is keyed on the open Bot (`MembersPageProfile.tsx`), so a Back onto another Bot unmounts a draft. What protects it is the app-wide layer:
  - The header arrows, ⌘/Ctrl+←/→ and (in the Mac app) the mouse side buttons go through `useGuardedHistoryStep`, which asks the page's registered route guard (`useRegisterNavigationLeaveGuard` in `MembersPage.tsx`) before stepping.
  - The browser's own Back is caught by `NavigationBackGuard`, which `MembersPage` arms through `usePublishNavigationStake(anyDraftAtStake)`. That trap is best-effort by design: it stays out of the stack while a Forward branch exists, and after a reload until it recalibrates. In those states, a raw browser Back onto another Bot drops the draft without asking.
  - This gap exists today for entries the rail pushed. The proposal makes it reachable from the header switcher too.
- **A Back while the New Bot card is open.** The landing effect in `MembersPage.tsx` closes the card only on a PUSH to a bare `/members`. A POP onto another Bot with the card open is not covered there. Not measured; listed in section 9.

## 7. Alternatives considered

- **Keep the replace.** No code changes, but the rail and the header switcher keep disagreeing, and #31418 stays as reported.
- **Make the rail replace too.** That gives consistency in the other direction, but it removes Back steps that work today, and Sessions stays the opposite rule. It also takes something away, so it would need its own `Reader:` list.
- **Push only for some controls** (for example the header switcher but not a thread's dashboard link). That keeps two rules for one gesture, which is the problem section 1 describes.

## 8. Rollout and tests

One small PR, with no flag, behind this document's acceptance. These tests in `pages/members/MembersPage.landing.test.tsx` change:

- "the auto-open from a bare desktop URL replaces, and a follow-up switch replaces too: Back leaves the page in one press": the arrival half stays; the switch half becomes "a follow-up switch pushes, so Back returns to the first Bot".
- "switching members holds ONE history entry: after walking two members, Back leaves the page in one press": it becomes a walk-back test, where Back retraces the Bots and one more Back leaves the page.

New cases pin the re-click (no write), the team-view-to-Bot open (still a replace), and "creating a Bot while another is open replaces, Back leaves the page". The narrow tests stay as they are. If section 6's gap is closed in the same PR (section 9, question 1), a test pins that a POP onto another Bot over a Schedules draft asks first.

## 9. Open questions

1. Should the URL-to-Bot sync ask the page's own leave check before honouring a POP onto another Bot, closing the best-effort gap in section 6 for both the rail and the switcher? Or is that a separate fix, since the rail already has it?
2. Should `openTeam` follow the same rule (push on desktop), so a Bot-to-team switch is a Back step too?
3. Should the phone rail's `DockMatesTiles` keep `replace`? It matches the mobile Sessions rule, so this document assumes yes.
4. Should a POP onto another Bot while the New Bot card is open ask, as the PUSH to a bare `/members` does?
