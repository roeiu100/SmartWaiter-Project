import type { NavigatorScreenParams } from "@react-navigation/native";

export type CustomerStackParamList = {
  Guest: { tableId?: string } | undefined;
  Chat: undefined;
};

export type ManagerStackParamList = {
  ManagerHome: undefined;
  ManagerAnalytics: undefined;
};

export type ManagerTabParamList = {
  ManagerTab: NavigatorScreenParams<ManagerStackParamList> | undefined;
  KitchenTab: undefined;
  RunnerTab: undefined;
};

export type StaffStackParamList = {
  AuthGate: undefined;
  KitchenOnly: undefined;
  RunnerOnly: undefined;
  ManagerTabs: NavigatorScreenParams<ManagerTabParamList> | undefined;
};

export type RootStackParamList = {
  Customer: NavigatorScreenParams<CustomerStackParamList> | undefined;
  Staff: NavigatorScreenParams<StaffStackParamList> | undefined;
};
