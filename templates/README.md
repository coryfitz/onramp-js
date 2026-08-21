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
For `run mobile`, the requested port belongs to iOS and Android starts at the
next available port above it.
Each native launcher prepares its first complete bundle before opening the app
so a new project's initial Metro build cannot time out in the simulator.
The command remains attached to its Metro process; press Ctrl+C to stop it.

The root app includes safe-area context. Keep screen content inside the
generated safe-area provider or use `useSafeAreaInsets` for custom layouts.

Native display names, versions, identifiers, and the launcher icon are defined
in `app.json`. The icon must be a 1024×1024 PNG inside this project. OnRamp
synchronizes those values whenever a native platform is added or run without
replacing other native project changes.

For device-only secrets, install `react-native-keychain@^10.0.0` with
`--legacy-peer-deps` and use `onramp-js/secure-storage`. The optional adapter
uses non-cloud iOS Keychain protection and Android Keystore-backed storage; it
does not fall back to insecure web storage.

Frontend schema and managed tooling hashes are stored in
`.onramp/project.json`. Upgrade backups are stored in `.onramp/backups/`.

## Setup Requirements

### Android

- JDK 17; OnRamp can offer to install the Android emulator SDK components

`onramp-js run android` checks Google's stable package list and asks before
installing or upgrading the Emulator, system image, or reusable AVD.

### iOS (macOS only)

- Xcode + CocoaPods

`onramp-js run ios` installs Pods, checks Apple's preferred compatible
Simulator runtime, and asks before downloading a missing or newer runtime.
Xcode supplies the Simulator application itself.

`npx onramp-js repair ios` preserves `Podfile.lock`. Add `--fresh` only when a
new native dependency resolution is intentional.
