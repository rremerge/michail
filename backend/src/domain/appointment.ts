export type Appointment = {
  id: string;
  userId: string;
  title: string;
  appointmentAt: string;
  notes?: string;
  source: "web" | "email";
  createdAt: string;
};

export type CreateAppointmentInput = {
  userId: string;
  title: string;
  appointmentAt: string;
  notes?: string;
  source: "web" | "email";
};
