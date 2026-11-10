import mongoose, { Document, Schema, Types } from "mongoose";

export type UserRole = "super_admin" | "officer" | "student" | "public_creator";
export type UserGender = "male" | "female" | "other";

export interface IUser extends Document {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  role: UserRole;
  fullName?: string;
  matricNumber?: string;
  gender?: UserGender;
  avatarPath?: string;
  avatarLocked: boolean;
  profileCompleted: boolean;
  isActive: boolean;
  isSuspended: boolean;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ["super_admin", "officer", "student", "public_creator"],
      required: true,
    },
    fullName: { type: String, trim: true },
    matricNumber: { type: String, sparse: true, unique: true },
    gender: { type: String, enum: ["male", "female", "other"] },
    avatarPath: { type: String },
    avatarLocked: { type: Boolean, default: false },
    profileCompleted: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    isSuspended: { type: Boolean, default: false },
    mustChangePassword: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export default mongoose.model<IUser>("User", userSchema);
