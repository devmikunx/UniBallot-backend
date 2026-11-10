import mongoose, { Document, Schema, Types } from 'mongoose';
import { ELECTION_STATUS_ORDER, ElectionStatus } from '../config/constants';
import type { OfficeTally, CandidateTally } from '../services/results.service';
import type { IntegrityCheckJobResult } from '../jobs/integrityCheck.queue';

export interface IElection extends Document {
  _id:               Types.ObjectId;
  associationId:     Types.ObjectId;
  title:             string;
  description?:      string;
  electionCode:      string;
  status:            ElectionStatus;
  assignedOfficerId?: Types.ObjectId;
  isLocked:          boolean;
  candidatesLocked:  boolean;
  membersLocked:     boolean;
  published:         boolean;
  results?:          OfficeTally[] | null;
  integrityResult?:    IntegrityCheckJobResult | null;
  integrityCheckedAt?: Date | null;
  createdAt:           Date;
  updatedAt:           Date;
  electionMode:     'standard' | 'anonymous';
  createdByPublic?: Types.ObjectId;
  resultsPublic:    boolean;
  resultsToken?:    string;
}

const candidateTallySchema = new Schema<CandidateTally>({
  candidateId: { type: String, required: true },
  fullName:    { type: String, required: true },
  voteCount:   { type: Number, required: true, min: 0 },
  photoUrl:    { type: String, default: null },
}, { _id: false });

const officeTallySchema = new Schema<OfficeTally>({
  officeId:     { type: String, required: true },
  officeTitle:  { type: String, required: true },
  voteType:     { type: String, enum: ['competitive', 'confirmation'], required: true },
  totalVotes:   { type: Number, required: true, min: 0 },
  noVotes:      { type: Boolean, required: true },
  isTie:        { type: Boolean, required: true },
  winner:       { type: String, default: null },
  elected:      { type: Boolean, default: null },
  approveCount: { type: Number },
  rejectCount:  { type: Number },
  candidates:   { type: [candidateTallySchema], required: true },
}, { _id: false });

const electionSchema = new Schema<IElection>(
  {
    associationId:     { type: Schema.Types.ObjectId, ref: 'Association', required: false },
    title:             { type: String, required: true, trim: true },
    description:       { type: String },
    electionCode:      { type: String, required: true, unique: true, uppercase: true },
    status:            { type: String, enum: ELECTION_STATUS_ORDER, default: 'draft', required: true },
    assignedOfficerId: { type: Schema.Types.ObjectId, ref: 'User' },
    isLocked:          { type: Boolean, default: false },
    candidatesLocked:  { type: Boolean, default: false },
    membersLocked:     { type: Boolean, default: false },
    published:         { type: Boolean, default: false },
    results:           { type: [officeTallySchema], default: [] },
    integrityResult:    { type: Schema.Types.Mixed, default: null },
    integrityCheckedAt: { type: Date },
    electionMode:    { type: String, enum: ['standard', 'anonymous'], default: 'standard', required: true },
    createdByPublic: { type: Schema.Types.ObjectId, ref: 'User' },
    resultsPublic:   { type: Boolean, default: false },
    resultsToken:    { type: String },
  },
  { timestamps: true }
);

electionSchema.index({ resultsToken: 1 }, { unique: true, sparse: true });

export default mongoose.model<IElection>('Election', electionSchema);