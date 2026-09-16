# Vision

Alinery is a Playbook IDE for consequential work. We want developers to direct substantial work with AI while retaining a clear understanding of the problem, the process, and the result.

This document describes the direction of the project.

## Build resonant software

Alinery adopts the [Resonant Computing Manifesto](https://resonantcomputing.org/) as a foundation for product decisions. Its five principles are **Private, Dedicated, Plural, Adaptable, and Prosocial**. The guidance below is our translation of those principles into everyday work on Alinery.

| Principle | What it means when we build Alinery |
| --- | --- |
| **Private** | When a feature sends task content to a service, make the destination, purpose, and user's control clear. Keep telemetry optional and separate from the content needed to perform the user's task. |
| **Dedicated** | Design notifications around decisions that need attention. Judge features by useful work and attention saved; avoid interruptions intended merely to bring someone back into the app. |
| **Plural** | Use portable files and inspectable formats. Preserve the ability to use artifacts, code, and Playbooks with other tools, and make integrations replaceable where practical. |
| **Adaptable** | Whenever we add a quality-of-life feature, try to include settings that let users customize it to their needs. Provide thoughtful defaults and a clear way to change them. |
| **Prosocial** | Make results useful to the next person: preserve the reasoning, uncertainty, and verification needed to review or continue the work. Support sharing useful Playbooks without requiring people to share private task context. |

### Make customization part of feature design

A convenience for one person can interrupt another. When proposing a quality-of-life feature, consider which parts depend on personal preference and how the user will control them. We should usually provide a setting to adjust or disable those behaviors as part of the feature.

For example:

- **Notifications:** let users choose which events interrupt them and whether they make a sound.
- **Automatic scrolling:** let users turn it off and preserve their position while they read earlier output.
- **Presentation:** make information density and default expansion of chat details adjustable; respect accessibility preferences such as reduced motion.
- **Keyboard shortcuts:** allow customization when a new shortcut changes how people navigate or work.

Use existing Settings sections and preference mechanisms where they fit. Make choices easy to discover, preserve them across restarts and updates, and provide a way to restore defaults. Personal display preferences should not silently become requirements for everyone working in the repository.

In feature descriptions and reviews, explain the default behavior and what the user can customize. If a preference-sensitive behavior cannot be customized, explain that tradeoff.

## Make room for deeper work

Working with agents can demand a surprising amount of attention. Someone still has to frame the problem, carry context between sessions, notice when an assumption changes, and decide whether a result is good enough to build on. As more work runs in parallel, those responsibilities can fill the day.

Alinery should help people enter and sustain **deeper flow states**. That means giving agents room to work while making the moments that need human judgment clear. A developer should be able to concentrate on a difficult decision, review a result carefully, or step away without having to watch every message arrive.

When someone is making decisions, reviewing code, or reading and commenting on artifacts, the interface should be still. Activity elsewhere must not compete for their attention. Every view used for deep work must offer an obvious way to become distraction-free.

In distraction-free mode:

- Suppress animations, pulsing indicators, live counters, and background activity feeds.
- Silence sounds and app-generated notifications, including toasts, banners, and desktop notifications.
- Prevent unsolicited scrolling, panel opening, task reordering, and layout shifts. Preserve the user's reading position, selection, keyboard focus, and comment drafts.
- Let agents continue working in the background. Collect results and requests for input quietly so the user can inspect them when ready.

Provide one clear control to enter and leave this mode, and remember the user's preference. Every new feature that introduces movement or interruptions must respect it. Users should be able to stay with the task they chose for as long as they need.

We care about how much useful, verified work a person can direct with the attention they have. More agent activity is valuable when it produces progress the developer can understand and stand behind.

## Keep the work together

A substantial engineering task spans questions, investigation, decisions, implementation, tests, and review. It often needs several agent sessions and a few changes of direction. The task should remain understandable through all of them.

The task is Alinery's organizing unit. Sessions, artifacts, decisions, and related sub-tasks belong to that work. When someone returns to it, they should be able to see what was attempted, what was learned, which decisions still matter, and what needs attention next. Exploring a side question should preserve its connection to the reason it was asked.

Sub-tasks should make it natural to use different Playbooks for different parts of a task and go down rabbit holes without losing track of the main work. Developers should be able to build on useful results, discard an approach, or run another agent review Playbook until they are satisfied with the result. The amount of investigation and review should reflect the stakes of the work.

This is also how context should improve over time. A useful investigation or a carefully reviewed decision should remain available to the next Step, without requiring a person to reconstruct it from a long conversation.

## Make the process visible through Playbooks

A Playbook describes how agents work together through a reusable graph of Steps. It makes the approach available to inspect and change: what each Step is trying to accomplish, what it receives, what it should produce, and where a person needs to participate.

For example, a change might require an investigation before a design decision, an agreed plan before implementation, and evidence from tests before review. Writing that process down helps the developer maintain an accurate mental model of the work. It also makes the process something that can be improved after a disappointing result.

Playbooks should be adaptable to the work and the people doing it. A small fix and an unfamiliar architectural change deserve different levels of investigation and review. The goal is to make a considered approach easy to repeat and easy to steer when the circumstances change.

## Put human review into the process

We believe some friction is useful. A pause to examine an assumption, compare two approaches, or review a plan can prevent a great deal of work in the wrong direction. Those pauses should be designed into the Playbook from the beginning.

Review should give a person a concrete decision to make, with enough context to make it well. What does the evidence support? What remains uncertain? Which tradeoff are we accepting? What would need to change before continuing? An approval button without that context contributes little.

Automation should carry routine work between those decisions. The developer remains responsible for choosing the direction, challenging the result, and deciding what to ship. Alinery should help make that responsibility practical as the amount of agent work grows.

## Work through artifacts and code

Direct agent chat is a low-level tool. It is useful for debugging, intervention, and questions that do not yet have a clear shape. Our intended way of working puts most human attention on artifacts, code, and the decisions they support.

An investigation should leave findings that can be checked. A plan should expose assumptions and intended changes. An implementation should come with a diff and relevant verification. These outputs give the developer something specific to review, comment on, reject, or carry into the next Step.

Alinery should make reviewing and revising those outputs the natural way to steer. The work should become easier to assess without requiring the human to read every intermediate thought or keep a conversation moving by hand.

## Keep developers in control

Local files, ordinary Git branches and worktrees, and inspectable artifacts give developers a familiar foundation. We want people to understand where their work lives, use it with other tools, and retain it when an individual session ends.

Control also means predictable boundaries. Leaving the interface should not silently end ongoing work. Actions that stop sessions or remove work should make their consequences clear. As Alinery gains more autonomy, a person should still be able to understand what is happening, intervene, and choose what happens next.

## What success looks like

We want a developer to be able to take on a consequential task, choose and adapt a Playbook, let agents make progress, and return to a coherent set of results worth reviewing. They should spend more of their attention understanding the problem and shaping the solution, with fewer interruptions to coordinate the mechanics.

We should assess progress through real use, including whether people can explain the decisions behind the code, catch mistakes at useful checkpoints, and resume work without reconstructing the whole task.

---

[Back to the README](README.md) · [Project website](https://alinery.ai)
