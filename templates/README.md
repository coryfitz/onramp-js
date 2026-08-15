# __ONRAMP_APP_NAME__

React Native app with React Strict DOM and file-based navigation.

## File-Based Routing

- app/index.tsx -> /
- app/profile/[id].tsx -> /profile/:id
- app/(tabs)/home.tsx -> /home with tabs layout

## Development

    # Generate routes from file structure
    npm run build:routes
    # Run on Android
    npm run android
    # Run on iOS (macOS only)
    npm run ios
    # Start Metro bundler with route generation
    npm start
    # Run on web
    npm run web

## Setup Requirements

### Android

- Android Studio + Android SDK + JDK

### iOS (macOS only)

- Xcode + iOS Simulator + CocoaPods
