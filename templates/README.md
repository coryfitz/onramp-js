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
    npm run web
    # Add native projects only when needed
    npx onramp-js add ios
    npx onramp-js add android
    # Check platform development tools
    npx onramp-js doctor ios
    npx onramp-js doctor android
    # Prepare and run native apps
    npx onramp-js run ios
    npx onramp-js run android
    # Start Metro bundler with route generation
    npm start

## Setup Requirements

### Android

- Android Studio + Android SDK + JDK

`onramp-js run android` locates the SDK and JDK 17 without requiring shell
profile changes.

### iOS (macOS only)

- Xcode + iOS Simulator + CocoaPods

`onramp-js run ios` installs Pods and selects a compatible simulator
automatically.
