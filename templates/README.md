# __ONRAMP_APP_NAME__

React Native app with React Strict DOM and file-based navigation.

## File-Based Routing

- app/index.tsx -> /
- app/profile/[id].tsx -> /profile/:id
- app/(tabs)/home.tsx -> /home with tabs layout

## Development

    # Generate routes from file structure
    npm run build:routes
    # Run on the web
    npx onramp-js run web
    # Add native projects only when needed
    npx onramp-js add ios
    npx onramp-js add android
    # Check platform development tools
    npx onramp-js doctor ios
    npx onramp-js doctor android
    # Safely inspect or apply framework tooling upgrades
    npx onramp-js upgrade --check
    npx onramp-js upgrade
    # Prepare and run native apps
    npx onramp-js run ios
    npx onramp-js run android
    npx onramp-js run mobile
    # Start Metro; routes are generated and watched automatically
    npm start

Native runs choose a free Metro port beginning at 8081. To require a specific
free port, pass `--metro-port 8082` to `onramp-js run ios` or Android.
For `run mobile`, the requested port belongs to Android and iOS starts at the
next available port above it.
Each native launcher prepares its first complete bundle before opening the app
so a new project's initial Metro build cannot time out in the simulator.
After a successful native build, unchanged native inputs reuse that installed
app while current JavaScript and TypeScript continue to come from Metro. Pass
`--rebuild` to a native run to force compilation and installation.
The command remains attached to its Metro process; press Ctrl+C to stop it.

Use `--environment development`, `--environment staging`, or
`--environment production` to select a profile from `app.json`. Profiles share
one universal runtime configuration while allowing platform-specific API URLs,
display-name suffixes, and native identifier suffixes. Import
`RuntimeConfigProvider` and `useRuntimeConfig` from
`onramp-js/runtime-config`. Route generation refreshes the ignored runtime
artifact, so tests, type checks, and production builds cannot accidentally
reuse an API URL generated for a different environment.

The root app includes safe-area context. Keep screen content inside the
generated safe-area provider or use `useSafeAreaInsets` for custom layouts.

## Cross-platform layout and styling

OnRamp uses React Strict DOM so the same route can render on web, iOS, and
Android. Define styles with `css.create` and pass the resulting typed styles to
the `style` prop. Avoid casting inline style objects with `as any`; those casts
hide values that browsers accept but native renderers reject.

In every shared route or component, import both APIs from React Strict DOM:

```tsx
import { css, html } from 'react-strict-dom';
```

Do not import `css` directly from `@stylexjs/stylex` in shared code. Direct
StyleX output is web-only and native renderers will ignore it. Use a direct
StyleX import only inside an explicitly web-only `.web.*` module.

Native text must live in a text-bearing element. In particular, wrap text and
interpolated values inside layout elements with `html.span`:

```tsx
<html.div style={styles.status}>
  <html.span>{status}</html.span>
</html.div>
```

Flexbox alignment belongs on a layout element such as `html.div`, not on
`html.span`. A span becomes native text on iOS and Android, where
`alignItems` and `justifyContent` do not center that text's own glyph. For a
centered badge, put those properties on an `html.div` and render its label in a
nested `html.span`.
Do not rely on text styles inheriting through an `html.div`; native `View`
boundaries do not inherit typography, so style the nested text element
explicitly.

Use strings for unitless CSS line-height ratios, such as
`lineHeight: '1.5'`. A numeric value such as `1.5` is interpreted by React
Native as an absolute 1.5-point line height. Percentage dimensions require
`boxSizing: 'border-box'`; flex sizing is usually more predictable across all
three targets.

Each route owns its scrolling behavior. Wrap a normal document-like route in
`ScrollScreen`, as the generated home and dynamic routes do. Do not wrap a
route that owns a `FlatList`, another `ScrollView`, a map, or a fixed canvas;
nested vertical scroll containers interfere with native list virtualization.

Responsive behavior is platform-resolved through
`src/use-compact-layout.ts` and `src/use-compact-layout.web.ts`. Native uses
`useWindowDimensions`, while web listens for viewport resizing. Keep shared
imports extension-free and place non-route helpers under `src/`, not `app/`.

Run `npm test` after changing shared route markup or styles. The starter's
native render smoke test exercises compact and wide versions of both routes
and fails on raw native text and known cross-platform style warnings. A web
build cannot detect every native rendering problem, so verify meaningful
layout changes in at least one simulator or emulator as well.

Native display names, versions, identifiers, and the launcher icon are defined
in `app.json`. The icon must be a 1024×1024 PNG inside this project. OnRamp
synchronizes those values whenever a native platform is added or run without
replacing other native project changes.

For device-only secrets, install `react-native-keychain@^10.0.0` with
`--legacy-peer-deps` and use `onramp-js/secure-storage`. The optional adapter
uses non-cloud iOS Keychain protection and Android Keystore-backed storage; it
does not fall back to insecure web storage.

Apps that enable OnRamp's backend accounts can import `AccountProvider`,
`useAccount`, and generic verified-notification helpers from `onramp-js/auth`.
Native bearer sessions use secure storage; web uses an HttpOnly cookie and
never writes the session token to JavaScript storage.

Frontend schema and managed tooling hashes are stored in
`.onramp/project.json`. Upgrade backups are stored in `.onramp/backups/`.

## Setup Requirements

### Android

- JDK 17; OnRamp can offer to install the Android emulator SDK components

`onramp-js run android` checks Google's stable package list and asks before
installing or upgrading the Emulator, system image, or reusable AVD. It also
identifies the exact selected emulator from its device serial and asks the
desktop to bring that window to the front when the AVD is reused or booted and
after the app opens. It verifies final focus where the desktop exposes it.
On macOS, a mobile run returns Android to the front after iOS has finished
launching; the iOS Simulator remains open behind it. Windows may decline a
foreground request, in which case OnRamp asks it to flash the emulator's
taskbar button.
Linux uses Sway directly or optional `wmctrl`/`xdotool` X11 tools. Generic pure
Wayland desktops control focus themselves, so OnRamp may ask you to select the
emulator from the task switcher even though the app launched successfully.

### iOS (macOS only)

- Xcode + CocoaPods

`onramp-js run ios` installs Pods, checks Apple's preferred compatible
Simulator runtime, and asks before downloading a missing or newer runtime.
Xcode supplies the Simulator application itself.

`npx onramp-js repair ios` preserves `Podfile.lock`. Add `--fresh` only when a
new native dependency resolution is intentional.
