import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IAnonVoterToken extends Document {
  electionId: Types.ObjectId;
  token:      string;
  votedAt:    Date;
  expiresAt:  Date;
}

const anonVoterTokenSchema = new Schema<IAnonVoterToken>({
  electionId: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
  token:      { type: String, required: true },
  votedAt:    { type: Date, required: true },
  expiresAt:  { type: Date, required: true },
}, { timestamps: false });

anonVoterTokenSchema.index({ electionId: 1, token: 1 }, { unique: true });
anonVoterTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IAnonVoterToken>('AnonVoterToken', anonVoterTokenSchema);
