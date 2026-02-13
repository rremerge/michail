import { randomUUID } from "node:crypto";
import type { Appointment, CreateAppointmentInput } from "../domain/appointment.js";

// Placeholder in-memory store. Replace with DynamoDB integration.
const appointmentStore = new Map<string, Appointment[]>();

export function listAppointments(userId: string): Appointment[] {
  return appointmentStore.get(userId) ?? [];
}

export function createAppointment(input: CreateAppointmentInput): Appointment {
  const appointment: Appointment = {
    id: randomUUID(),
    userId: input.userId,
    title: input.title,
    appointmentAt: input.appointmentAt,
    notes: input.notes,
    source: input.source,
    createdAt: new Date().toISOString()
  };

  const existing = appointmentStore.get(input.userId) ?? [];
  appointmentStore.set(input.userId, [...existing, appointment]);

  return appointment;
}
