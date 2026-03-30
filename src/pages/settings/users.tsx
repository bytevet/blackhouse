import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";
import { useSession } from "@/lib/auth-client";
import { client, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Field, FieldLabel, FieldError, FieldGroup } from "@/components/ui/field";
import { Plus, Trash2 } from "lucide-react";

interface UserRow {
  id: string;
  name: string;
  email: string;
  username?: string | null;
  role?: string | null;
}

const createUserSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().min(1, "Email is required").email("Invalid email address"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  role: z.string(),
});

export function UsersPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const isAdmin = session?.user?.role === "admin";

  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingUser, setDeletingUser] = useState<UserRow | null>(null);
  const [creating, setCreating] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    email: "",
    username: "",
    password: "",
    role: "user",
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isAdmin && session) {
      navigate("/settings/profile", { replace: true });
      return;
    }
    client.api.settings.users
      .$get()
      .then((r) => unwrap<UserRow[]>(r))
      .then(setUsers)
      .finally(() => setLoading(false));
  }, [isAdmin, session, navigate]);

  const refresh = async () => {
    const res = await client.api.settings.users.$get();
    setUsers(await unwrap<UserRow[]>(res));
  };

  const openCreate = () => {
    setFormData({ name: "", email: "", username: "", password: "", role: "user" });
    setFormErrors({});
    setDialogOpen(true);
  };

  const handleCreateUser = async () => {
    setFormErrors({});
    const result = createUserSchema.safeParse(formData);
    if (!result.success) {
      const errs: Record<string, string> = {};
      for (const issue of result.error.issues) {
        errs[issue.path[0] as string] = issue.message;
      }
      setFormErrors(errs);
      return;
    }
    setCreating(true);
    try {
      await client.api.settings.users.$post({
        json: {
          name: result.data.name.trim(),
          email: result.data.email.trim(),
          username: result.data.username.trim(),
          password: result.data.password,
          role: result.data.role,
        },
      });
      setDialogOpen(false);
      await refresh();
    } finally {
      setCreating(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: string) => {
    await client.api.settings.users[":id"].role.$put({
      param: { id: userId },
      json: { role: newRole },
    });
    await refresh();
  };

  const handleDelete = async () => {
    if (!deletingUser) return;
    await client.api.settings.users[":id"].$delete({ param: { id: deletingUser.id } });
    setDeleteDialogOpen(false);
    setDeletingUser(null);
    await refresh();
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading users...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Manage platform users and their roles. Only admins can access this page.
        </p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-3" />
          Add User
        </Button>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">Email</TableHead>
              <TableHead className="hidden sm:table-cell">Username</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.name}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {u.email}
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {u.username || "\u2014"}
                </TableCell>
                <TableCell>
                  <Select
                    value={u.role || "user"}
                    onValueChange={(val) => val !== null && handleRoleChange(u.id, val)}
                    items={[
                      { label: "User", value: "user" },
                      { label: "Admin", value: "admin" },
                    ]}
                  >
                    <SelectTrigger className="h-6 w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      setDeletingUser(u);
                      setDeleteDialogOpen(true);
                    }}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Add User Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>Create a new platform user.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!formErrors.name || undefined}>
              <FieldLabel>Name</FieldLabel>
              <Input
                value={formData.name}
                onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              />
              {formErrors.name && <FieldError errors={[{ message: formErrors.name }]} />}
            </Field>
            <Field data-invalid={!!formErrors.email || undefined}>
              <FieldLabel>Email</FieldLabel>
              <Input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
              />
              {formErrors.email && <FieldError errors={[{ message: formErrors.email }]} />}
            </Field>
            <Field data-invalid={!!formErrors.username || undefined}>
              <FieldLabel>Username</FieldLabel>
              <Input
                value={formData.username}
                onChange={(e) => setFormData((prev) => ({ ...prev, username: e.target.value }))}
              />
              {formErrors.username && <FieldError errors={[{ message: formErrors.username }]} />}
            </Field>
            <Field data-invalid={!!formErrors.password || undefined}>
              <FieldLabel>Password</FieldLabel>
              <Input
                type="password"
                value={formData.password}
                onChange={(e) => setFormData((prev) => ({ ...prev, password: e.target.value }))}
              />
              {formErrors.password && <FieldError errors={[{ message: formErrors.password }]} />}
            </Field>
            <Field>
              <FieldLabel>Role</FieldLabel>
              <Select
                value={formData.role}
                onValueChange={(v) => v !== null && setFormData((prev) => ({ ...prev, role: v }))}
                items={[
                  { label: "User", value: "user" },
                  { label: "Admin", value: "admin" },
                ]}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button onClick={handleCreateUser} disabled={creating}>
              {creating ? "Creating..." : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deletingUser?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
