import React from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { NavigationProvider, useNavigation } from './src/navigation/NavigationProvider';
import { RouteComponent } from './src/navigation/RouteRegistry';

function AppContent() {
  const { currentRoute, params } = useNavigation();
  return <RouteComponent path={currentRoute} params={params} />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1 }}>
        <NavigationProvider initialRoute="/">
          <AppContent />
        </NavigationProvider>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
