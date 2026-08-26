import React, { PropsWithChildren } from 'react';
import { ScrollView } from 'react-native';

export function ScrollScreen({ children }: PropsWithChildren) {
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ flexGrow: 1 }}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}
