export type UserStatus = 'active' | 'inactive';

export interface User {
  userId: number;
  firstName: string;
  username: string | null;
  status: UserStatus;
  timezone: string | null;
}

export interface Session {
  sessionName: string;
  dateStart: Date;
  dateEnd: Date | null;
  sessionKey: number | null;
  meetingKey: number | null;
  meetingName: string | null;
  location: string | null;
  sessionType: string | null;
}

export interface PodiumFinisher {
  position: number;
  driverName: string;
  teamName: string;
}

export interface PostRaceBriefing {
  completedRace: Session;
  podium: [PodiumFinisher, PodiumFinisher, PodiumFinisher];
  nextGrandPrix: string | null;
  daysLeft: number | null;
}

export interface BotSettings {
  alertLeadTimeMinutes: number | null;
  postRaceDeltaMinutes: number | null;
  postRaceMaxWindowMinutes: number | null;
}

export interface MeetingDetails {
  name: string | null;
  shortName: string | null;
  location: string | null;
}

export function buildNewUser(input: {
  userId: number;
  firstName: string;
  username?: string | null;
}): User {
  return {
    userId: input.userId,
    firstName: input.firstName,
    username: input.username ?? null,
    status: 'inactive',
    timezone: 'UTC',
  };
}
