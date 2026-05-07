import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      isAdmin: boolean;
      sessionVersion: number;
    };
  }

  interface User {
    id?: string;
    email?: string | null;
    name?: string | null;
    image?: string | null;
    isAdmin?: boolean;
    sessionVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    isAdmin?: boolean;
    sessionVersion?: number;
    displayName?: string;
    email?: string;
  }
}
