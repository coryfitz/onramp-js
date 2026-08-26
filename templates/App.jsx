import React from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { NavigationProvider, useNavigation } from './src/navigation/NavigationProvider';
import { RouteComponent } from './src/navigation/RouteRegistry';

function AppContent() {
  const { currentRoute, params } = useNavigation();
  return (
    <ScrollView
      key={currentRoute}
      style={{ flex: 1 }}
      contentContainerStyle={{ flexGrow: 1 }}
      showsVerticalScrollIndicator={false}
    >
      <RouteComponent path={currentRoute} params={params} />
    </ScrollView>
  );
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
