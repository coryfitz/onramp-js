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

## Setup Requirements

### Android

- Android Studio + Android SDK + JDK

`onramp-js run android` locates the SDK and JDK 17 without requiring shell
profile changes.

### iOS (macOS only)

- Xcode + iOS Simulator + CocoaPods

`onramp-js run ios` installs Pods and selects a compatible simulator
automatically.

`npx onramp-js repair ios` preserves `Podfile.lock`. Add `--fresh` only when a
new native dependency resolution is intentional.
