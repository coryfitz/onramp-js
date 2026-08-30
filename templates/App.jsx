import React from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { NavigationProvider, useNavigation } from './src/navigation/NavigationProvider';
import { RouteComponent } from './src/navigation/RouteRegistry';
import {RuntimeConfigProvider} from 'onramp-js/runtime-config';
import runtimeConfig from './src/generated/runtime-config.json';

function AppContent() {
  const { currentRoute, params } = useNavigation();
  return <RouteComponent path={currentRoute} params={params} />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <RuntimeConfigProvider initialConfig={runtimeConfig}>
        <SafeAreaView style={{ flex: 1 }}>
          <NavigationProvider initialRoute="/">
            <AppContent />
          </NavigationProvider>
        </SafeAreaView>
      </RuntimeConfigProvider>
    </SafeAreaProvider>
  );
}
