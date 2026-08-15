import type { NavigatorScreenParams } from "@react-navigation/native";

export type CustomerStackParamList = {
  Chat: { tableId?: string } | undefined;
  Guest: { tableId?: string } | undefined;
  Bill: undefined;
};

export type ManagerStackParamList = {
  ManagerHome: undefined;
  ManagerAnalytics: undefined;
};

export type ManagerTabParamList = {
  ManagerTab: NavigatorScreenParams<ManagerStackParamList> | undefined;
  KitchenTab: undefined;
  RunnerTab: undefined;
  TablesTab: undefined;
};

export type RunnerStackParamList = {
  RunnerHome: undefined;
  TableMap: undefined;
};

export type StaffStackParamList = {
  AuthGate: undefined;
  KitchenOnly: undefined;
  RunnerOnly: NavigatorScreenParams<RunnerStackParamList> | undefined;
  ManagerTabs: NavigatorScreenParams<ManagerTabParamList> | undefined;
};

export type RootStackParamList = {
  Customer: NavigatorScreenParams<CustomerStackParamList> | undefined;
  Staff: NavigatorScreenParams<StaffStackParamList> | undefined;
};
